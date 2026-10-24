//! Synchronisation incrémentale du catalogue avec le disque : fichiers ajoutés, modifiés ou supprimés hors de l'application.
//!
//! Le parcours des dossiers ne lit que la taille et la date de modification (fournies par l'énumération des dossiers,
//! sans ouvrir les fichiers). L'EXIF n'est relu que pour les fichiers nouveaux ou modifiés, avec 2 threads au plus
//! pour ne pas gêner l'interface.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use rusqlite::params;
use serde::Serialize;
use walkdir::WalkDir;

use crate::db::{self, DbPool, Photo};
use crate::{insert_batch, is_inside_folder, tracked_root_is_reachable};

static RUNNING: AtomicBool = AtomicBool::new(false);

struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Chemins concernés par la synchronisation ; l'interface recharge ensuite la liste des photos.
#[derive(Serialize, Default)]
pub struct SyncChanges {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
}

/// Date de modification en millisecondes depuis 1970 (0 si le système ne la fournit pas).
pub fn modified_millis(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Enregistre la date de modification (ms) des fichiers qui viennent d'être lus, par chemin.
pub fn store_modified(conn: &rusqlite::Connection, items: &[(String, i64)]) {
    let _ = conn.execute("BEGIN TRANSACTION", []);
    if let Ok(mut update) = conn.prepare_cached("UPDATE photos SET modified = ? WHERE path = ?") {
        for (path, modified) in items {
            let _ = update.execute(params![modified, path]);
        }
    }
    let _ = conn.execute("COMMIT", []);
}

// Mêmes formats que le scan initial (run_scan).
//fn is_photo_file(path: &Path) -> bool {
//    let name = path.to_string_lossy().to_lowercase();
//    name.ends_with(".jpg") || name.ends_with(".jpeg") || name.ends_with(".png") || name.ends_with(".raw")
//}
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    // Formats standards
    "jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "jfif",
    // HEIC / HEIF (décodage et métadonnées : heif.rs)
    "heic", "heif", "hif",
    // Formats RAW
    "arw", "cr2", "cr3", "nef", "nrw", "dng", "raf", "orf", "rw2", "raw",
    // Tried and removed:
    // Not working at all: jp2
    // Thumbnail only: svg
];
pub fn is_photo_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext_lower = ext.to_ascii_lowercase();
            SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str())
        })
        .unwrap_or(false)
}

fn read_photo(path: &str, file_size: i64) -> Photo {
    let source = Path::new(path);
    let exif_data = crate::exif::read_exif(source);
    Photo {
        id: 0,
        path: path.to_string(),
        filename: source.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        date_taken: exif_data.date_taken,
        aperture: exif_data.aperture,
        shutter_speed: exif_data.shutter_speed,
        iso: exif_data.iso,
        focal_length: exif_data.focal_length,
        manufacturer: exif_data.manufacturer,
        camera_model: exif_data.camera_model,
        lens_model: exif_data.lens_model,
        width: exif_data.width,
        height: exif_data.height,
        file_size,
        rating: exif_data.rating,
        color_flag: exif_data.color_flag,
        keywords: exif_data.keywords,
        caption: exif_data.caption,
        modified: 0, // non utilisé : la date est enregistrée séparément par sync_library
    }
}

/// Compare les dossiers suivis au catalogue :
/// - nouveau fichier : ajouté ;
/// - taille ou date de modification différentes : métadonnées relues ;
/// - fichier introuvable (dossier suivi joignable) : retiré ;
/// - ligne sans date enregistrée (catalogue antérieur à cette colonne ou scan manuel) : on enregistre simplement la date
///   si la taille n'a pas changé, sans relire le fichier.
/// Un seul passage à la fois : un appel pendant une synchronisation en cours ne fait rien.
pub fn sync_library(pool: &DbPool) -> Result<SyncChanges, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(SyncChanges::default());
    }
    let _guard = RunningGuard;
    let conn = pool.get().map_err(|error| error.to_string())?;
    // Un disque débranché ou un partage coupé n'est jamais pris pour une suppression : seuls les dossiers joignables sont parcourus.
    let roots: Vec<String> = db::get_folders(pool)
        .into_iter()
        .map(|folder| folder.path)
        .filter(|root| tracked_root_is_reachable(root))
        .collect();
    if roots.is_empty() {
        return Ok(SyncChanges::default());
    }

    // chemin -> (taille, date de modification) tels qu'enregistrés
    let mut known: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut statement = conn
            .prepare("SELECT path, file_size, modified FROM photos WHERE path IS NOT NULL")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                ))
            })
            .map_err(|error| error.to_string())?;
        for (path, size, modified) in rows.flatten() {
            known.insert(path, (size, modified));
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    // (chemin, taille, date de modification, nouveau fichier ?)
    let mut changed: Vec<(String, i64, i64, bool)> = Vec::new();
    let mut baseline: Vec<(String, i64)> = Vec::new();
    for root in &roots {
        for entry in WalkDir::new(root).into_iter().filter_map(|entry| entry.ok()) {
            if entry.file_type().is_dir() || !is_photo_file(entry.path()) {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if !seen.insert(path.clone()) {
                continue; // dossiers suivis imbriqués : un fichier n'est traité qu'une fois
            }
            let Ok(metadata) = entry.metadata() else { continue; };
            let size = metadata.len() as i64;
            let modified = modified_millis(&metadata);
            match known.get(&path) {
                None => changed.push((path, size, modified, true)),
                Some(&(known_size, known_modified)) => {
                    if known_size != size {
                        changed.push((path, size, modified, false));
                    } else if known_modified == 0 {
                        baseline.push((path, modified));
                    } else if known_modified != modified {
                        changed.push((path, size, modified, false));
                    }
                }
            }
        }
    }

    // Absent du parcours ne suffit pas (erreur de lecture pendant le parcours) : on confirme que le fichier est bien introuvable.
    let removed: Vec<String> = known
        .keys()
        .filter(|path| !seen.contains(path.as_str()) && roots.iter().any(|root| is_inside_folder(root, path.as_str())))
        .filter(|path| matches!(fs::metadata(path.as_str()), Err(error) if error.kind() == std::io::ErrorKind::NotFound))
        .cloned()
        .collect();

    if changed.is_empty() && baseline.is_empty() && removed.is_empty() {
        return Ok(SyncChanges::default());
    }

    if !changed.is_empty() {
        let threads = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .map_err(|error| error.to_string())?;
        let photos: Vec<Photo> = threads.install(|| {
            changed.par_iter().map(|(path, size, _, _)| read_photo(path, *size)).collect()
        });
        insert_batch(&conn, &photos);
    }

    let _ = conn.execute("BEGIN TRANSACTION", []);
    if let Ok(mut update) = conn.prepare_cached("UPDATE photos SET modified = ? WHERE path = ?") {
        for (path, _, modified, _) in &changed {
            let _ = update.execute(params![modified, path]);
        }
        for (path, modified) in &baseline {
            let _ = update.execute(params![modified, path]);
        }
    }
    for path in &removed {
        let _ = conn.execute("DELETE FROM photos WHERE path = ?", params![path]);
    }
    let _ = conn.execute("COMMIT", []);

    let (added, updated): (Vec<(String, i64, i64, bool)>, Vec<(String, i64, i64, bool)>) =
        changed.into_iter().partition(|item| item.3);
    Ok(SyncChanges {
        added: added.into_iter().map(|item| item.0).collect(),
        updated: updated.into_iter().map(|item| item.0).collect(),
        removed,
    })
}
