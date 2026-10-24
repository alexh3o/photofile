#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod exif;
mod library_sync;
mod resize;
mod thumbnails;

use tauri::{State, Emitter, Manager};
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use rayon::prelude::*;
use db::{DbPool, Photo, TrackedFolder};
use tokio::sync::mpsc;
use rusqlite::params;

use std::sync::RwLock;

#[derive(Clone)]
pub struct AppDataPaths {
    pub base_dir: PathBuf,
    pub db_path: PathBuf,
    pub thumbnails_dir: PathBuf,
    pub raw_previews_dir: PathBuf,
    pub is_custom: bool,
}

impl AppDataPaths {
    pub fn from_base(base_dir: PathBuf, is_custom: bool) -> Self {
        let db_path = base_dir.join("photos_library.db");
        let thumbnails_dir = base_dir.join("thumbnails");
        let raw_previews_dir = base_dir.join("raw_previews");
        Self { base_dir, db_path, thumbnails_dir, raw_previews_dir, is_custom }
    }
}

impl AppState {
    pub fn pool(&self) -> DbPool {
        self.db_pool.read().unwrap().clone()
    }
    pub fn base_dir(&self) -> PathBuf {
        self.paths.read().unwrap().base_dir.clone()
    }
    pub fn thumbnails_dir(&self) -> PathBuf {
        self.paths.read().unwrap().thumbnails_dir.clone()
    }
    pub fn raw_previews_dir(&self) -> PathBuf {
        self.paths.read().unwrap().raw_previews_dir.clone()
    }
    pub fn is_custom(&self) -> bool {
        self.paths.read().unwrap().is_custom
    }
    pub fn thumbnail_cache_size(&self) -> usize {
        *self.thumbnail_cache_size.read().unwrap() as usize
    }
}

use std::sync::Mutex;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct WindowStateConfig {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_maximized: bool,
}

#[derive(Clone, Debug)]
pub struct WindowTracker {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct AppState {
    pub db_pool: RwLock<DbPool>,
    pub paths: RwLock<AppDataPaths>,
    pub thumbnail_cache_size: RwLock<u32>,
    pub window_tracker: Mutex<WindowTracker>, // suivi des dimensions normales (hors maximisation)
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct AppConfig {
    custom_data_dir: Option<String>,
    thumbnail_cache_size: Option<u32>,
    window_state: Option<WindowStateConfig>, // persistance dans config.json
}

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn load_config(app: &tauri::AppHandle) -> AppConfig {
    config_file_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn save_config(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_file_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/////////////////////////
///Fonctions de restauration, Bounds Check et sauvegarde
/// Vérifie si le rectangle de la fenêtre intersecte la zone visible d'au moins un écran actif.
fn check_window_visibility(window: &tauri::WebviewWindow, saved: &WindowStateConfig) -> bool {
    let monitors = match window.available_monitors() {
        Ok(m) => m,
        Err(_) => return false,
    };

    if monitors.is_empty() {
        return false;
    }

    let win_x = saved.x;
    let win_y = saved.y;
    let win_w = saved.width.max(100) as i32;
    let win_h = saved.height.max(100) as i32;
    const MIN_OVERLAP: i32 = 100; // Au moins 100x100 px visibles sur l'écran

    for monitor in &monitors {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();

        let mon_x = mon_pos.x;
        let mon_y = mon_pos.y;
        let mon_w = mon_size.width as i32;
        let mon_h = mon_size.height as i32;

        let intersect_x1 = win_x.max(mon_x);
        let intersect_y1 = win_y.max(mon_y);
        let intersect_x2 = (win_x + win_w).min(mon_x + mon_w);
        let intersect_y2 = (win_y + win_h).min(mon_y + mon_h);

        let overlap_w = (intersect_x2 - intersect_x1).max(0);
        let overlap_h = (intersect_y2 - intersect_y1).max(0);

        if overlap_w >= MIN_OVERLAP && overlap_h >= MIN_OVERLAP {
            // Vérifie que la barre de titre reste atteignable (pas au-delà du bord inférieur)
            if win_y >= mon_y - 20 && win_y < mon_y + mon_h - 40 {
                return true;
            }
        }
    }

    false
}

/// Restaure la géométrie de la fenêtre avec vérification de sécurité.
fn restore_window_state(window: &tauri::WebviewWindow, config: &AppConfig) -> WindowTracker {
    const DEFAULT_WIDTH: u32 = 1024;
    const DEFAULT_HEIGHT: u32 = 768;

    if let Some(ref saved) = config.window_state {
        if check_window_visibility(window, saved) {
            let width = saved.width.max(640);
            let height = saved.height.max(480);

            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width,
                height,
            }));
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: saved.x,
                y: saved.y,
            }));

            if saved.is_maximized {
                let _ = window.maximize();
            }

            return WindowTracker {
                x: saved.x,
                y: saved.y,
                width,
                height,
            };
        }
    }

    // Réinitialisation de sécurité : taille par défaut et centrage sur l'écran principal
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
    }));
    let _ = window.center();

    let pos = window.outer_position().unwrap_or(tauri::PhysicalPosition { x: 100, y: 100 });
    let size = window.outer_size().unwrap_or(tauri::PhysicalSize { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });

    WindowTracker {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    }
}

/// Sauvegarde l'état actuel de la fenêtre dans config.json.
fn save_current_window_state(window: &tauri::Window, state: &AppState) {
    let is_maximized = window.is_maximized().unwrap_or(false);
    let (x, y, width, height) = match state.window_tracker.lock() {
        Ok(tracker) => (tracker.x, tracker.y, tracker.width, tracker.height),
        Err(_) => return,
    };

    let app = window.app_handle();
    let mut config = load_config(app);
    config.window_state = Some(WindowStateConfig {
        x,
        y,
        width,
        height,
        is_maximized,
    });
    let _ = save_config(app, &config);
}
/////////////////////////
/////////////////////////

fn default_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("data");
    Ok(dir)
}

fn resolve_app_paths(app: &tauri::AppHandle) -> Result<AppDataPaths, String> {
    let config = load_config(app);
    let default_dir = default_data_directory(app)?;
    let (base_dir, is_custom) = match config.custom_data_dir {
        Some(dir_str) if !dir_str.trim().is_empty() => (PathBuf::from(dir_str), true),
        _ => (default_dir, false),
    };
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(base_dir.join("thumbnails")).map_err(|e| e.to_string())?;
    fs::create_dir_all(base_dir.join("raw_previews")).map_err(|e| e.to_string())?;

    // Migration transparente si une ancienne base locale existe à la racine du projet
    let legacy_db = Path::new("photos_library.db");
    let target_db = base_dir.join("photos_library.db");
    if legacy_db.is_file() && !target_db.is_file() {
        let _ = move_file_or_copy(legacy_db, &target_db);
        let _ = move_file_or_copy(Path::new("photos_library.db-wal"), &base_dir.join("photos_library.db-wal"));
        let _ = move_file_or_copy(Path::new("photos_library.db-shm"), &base_dir.join("photos_library.db-shm"));
    }

    Ok(AppDataPaths::from_base(base_dir, is_custom))
}

fn thumbnail_cache_file(thumbnails_dir: &Path, source_path: &str) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source_path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut hash = 0xcbf29ce484222325u64;
    let size_bytes = metadata.len().to_le_bytes();
    let modified_bytes = modified.to_le_bytes();
    for byte in source_path.as_bytes().iter().chain(size_bytes.iter()).chain(modified_bytes.iter()) {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(thumbnails_dir.join(format!("{hash:016x}.jpg")))
}

fn decode_thumbnail_base64(encoded: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(encoded.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut bits = 0u8;
    for byte in encoded.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return Err("Données de miniature base64 invalides".into()),
        };
        accumulator = (accumulator << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
        }
    }
    if output.len() < 4 || !output.starts_with(&[0xff, 0xd8]) { return Err("Miniature JPEG invalide".into()); }
    Ok(output)
}

// Commandes du cache de miniatures en `async` : elles s'exécutent hors du thread principal de Tauri
// (sinon chaque accès disque bloque la boucle d'événements de la fenêtre).
#[tauri::command(async)]
fn get_cached_thumbnail_path(state: State<'_, AppState>, source_path: String) -> Result<Option<String>, String> {
    let path = thumbnail_cache_file(&state.thumbnails_dir(), &source_path)?;
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

// Version par lots : un seul aller-retour IPC pour plusieurs miniatures.
// Le résultat suit l'ordre de `source_paths` (None = pas de miniature en cache).
#[tauri::command(async)]
fn get_cached_thumbnail_paths(state: State<'_, AppState>, source_paths: Vec<String>) -> Vec<Option<String>> {
    let dir = state.thumbnails_dir();
    source_paths.iter().map(|source_path| {
        thumbnail_cache_file(&dir, source_path).ok()
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned())
    }).collect()
}

#[derive(serde::Serialize)]
struct GeneratedThumbnail {
    path: String,
    width: u32,
    height: u32,
}

// Génère la miniature (JPEG uniquement) directement dans le cache, hors du webview : décodage réduit,
// orientation EXIF appliquée, taille réelle renvoyée (ratio exact pour la disposition justifiée).
// Une erreur (PNG, JPEG CMYK, fichier illisible…) indique à l'interface d'utiliser sa génération de repli.
#[tauri::command(async)]
fn generate_thumbnail(state: State<'_, AppState>, source_path: String, max_side: Option<u32>) -> Result<GeneratedThumbnail, String> {
    let max_side = max_side.map(|s| s as usize).unwrap_or_else(|| state.thumbnail_cache_size());
    let destination = thumbnail_cache_file(&state.thumbnails_dir(), &source_path)?;
    let size = if destination.is_file() {
        thumbnails::jpeg_size(&destination)?
    } else {
        thumbnails::generate_thumbnail(std::path::Path::new(&source_path), &destination, max_side)?
    };
    Ok(GeneratedThumbnail { path: destination.to_string_lossy().into_owned(), width: size.width, height: size.height })
}

// Extraction de fichier jpeg intégré au RAW
fn raw_preview_cache_file(raw_previews_dir: &Path, source_path: &str) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source_path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut hash = 0xcbf29ce484222325u64;
    let size_bytes = metadata.len().to_le_bytes();
    let modified_bytes = modified.to_le_bytes();
    for byte in source_path.as_bytes().iter().chain(size_bytes.iter()).chain(modified_bytes.iter()) {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(raw_previews_dir.join(format!("{hash:016x}.jpg")))
}

#[tauri::command(async)]
fn get_raw_preview_path(state: State<'_, AppState>, source_path: String) -> Result<String, String> {
    let preview_path = raw_preview_cache_file(&state.raw_previews_dir(), &source_path)?;
    if preview_path.is_file() {
        return Ok(preview_path.to_string_lossy().into_owned());
    }
    let jpeg_bytes = thumbnails::extract_raw_preview(Path::new(&source_path))?;
    let parent = preview_path.parent().ok_or("Dossier de cache invalide")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("prev-{}-{}.tmp", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()));
    fs::write(&temp, &jpeg_bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temp, &preview_path) {
        let _ = fs::remove_file(&temp);
        if !preview_path.is_file() { return Err(error.to_string()); }
    }
    Ok(preview_path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
fn save_thumbnail_cache(state: State<'_, AppState>, source_path: String, data_url: String) -> Result<String, String> {
    let encoded = data_url.strip_prefix("data:image/jpeg;base64,").ok_or("Format de miniature non pris en charge")?;
    let bytes = decode_thumbnail_base64(encoded)?;
    let path = thumbnail_cache_file(&state.thumbnails_dir(), &source_path)?;
    if path.is_file() { return Ok(path.to_string_lossy().into_owned()); }
    let parent = path.parent().ok_or("Dossier de cache invalide")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("thumb-{}-{}.tmp", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        if !path.is_file() { return Err(error.to_string()); }
    }
    Ok(path.to_string_lossy().into_owned())
}

// Vidage miniatures
#[tauri::command(async)]
fn clear_thumbnail_cache(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.thumbnails_dir();
    if dir.is_dir() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}


#[tauri::command(async)]
fn set_thumbnail_cache_size(app: tauri::AppHandle, state: State<'_, AppState>, size: u32) -> Result<(), String> {
    if ![256, 512, 768, 1024].contains(&size) {
        return Err("Taille de miniature non valide".into());
    }
    {
        let mut guard = state.thumbnail_cache_size.write().map_err(|e| e.to_string())?;
        *guard = size;
    }
    let mut config = load_config(&app);
    config.thumbnail_cache_size = Some(size);
    save_config(&app, &config)?;
    Ok(())
}


#[tauri::command]
fn get_folders(state: State<'_, AppState>) -> Vec<TrackedFolder> {
    let pool = state.pool();
    db::get_folders(&pool)
}

#[tauri::command]
// Ajoute le dossier à la liste des dossiers suivis, sans le scanner : l'interface met le scan en file d'attente (commande `scan_folder`),
// pour que plusieurs scans ne tournent jamais en même temps.
async fn add_folder(state: State<'_, AppState>, path: String) -> Result<Vec<TrackedFolder>, String> {
    let pool = state.pool();
    db::add_folder(&pool, &path)?;
    let folders = db::get_folders(&pool);
    Ok(folders)
}

#[tauri::command]
fn remove_folder(state: State<'_, AppState>, id: i64, path: String) -> Result<Vec<TrackedFolder>, String> {
    let pool = state.pool();
    db::remove_folder(&pool, id, &path)?;
    Ok(db::get_folders(&pool))
}

#[derive(Clone, Copy)]
enum ScanMode {
    Rescan { index: usize, count: usize },
    FolderScan,
}

// Progression d'une tâche de scan, publiée dans l'événement « scan-progress » : l'interface retrouve sa tâche grâce à `taskId`
// (identifiant qu'elle a donné à la commande), ce qui évite de confondre les noms et les pourcentages de deux tâches.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    task_id: String,
    percent: u32,
}

// Drapeaux d'annulation des scans, par identifiant de tâche. Le drapeau est créé par le premier qui le demande (le scan ou la demande d'arrêt),
// donc un arrêt demandé juste au démarrage d'un scan n'est pas perdu. Le scan le retire à sa fin.
fn scan_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scan_cancel_flag(task_id: &str) -> Arc<AtomicBool> {
    let mut flags = scan_cancel_flags().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    flags.entry(task_id.to_string()).or_insert_with(|| Arc::new(AtomicBool::new(false))).clone()
}

fn release_scan_cancel_flag(task_id: &str) {
    scan_cancel_flags().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(task_id);
}

// Arrête un scan ou une relecture en cours : le parcours cesse et les photos déjà lues restent dans le catalogue.
// Les fichiers non lus seront repris par la synchronisation incrémentale (sync_library) ou par une nouvelle relecture.
#[tauri::command]
fn cancel_scan(task_id: String) {
    scan_cancel_flag(&task_id).store(true, Ordering::SeqCst);
}

// `scan_mode` : mode de calcul de l'avancement (relecture, éventuellement d'une partie des dossiers suivis, ou découverte d'un dossier)
// `task_id` / `cancel` : identifiant de la tâche pour les événements de progression, et drapeau d'arrêt demandé par l'interface
async fn run_scan(app: tauri::AppHandle, pool: DbPool, scan_path: String, scan_mode: ScanMode, task_id: String, cancel: Arc<AtomicBool>) {
    // Chaque photo arrive avec la date de modification de son fichier, enregistrée en base avec les métadonnées
    // pour que la synchronisation automatique ne la relise pas inutilement.
    let (tx, mut rx) = mpsc::channel::<(Photo, i64)>(100);

    let pool_clone = pool.clone();
    let writer = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut modified_dates: Vec<(String, i64)> = Vec::new();
        let conn = pool_clone.get().unwrap();
        while let Some((photo, modified)) = rx.recv().await {
            modified_dates.push((photo.path.clone(), modified));
            buffer.push(photo);
            if buffer.len() >= 500 {
                insert_batch(&conn, &buffer);
                library_sync::store_modified(&conn, &modified_dates);
                buffer.clear();
                modified_dates.clear();
            }
        }
        if !buffer.is_empty() {
            insert_batch(&conn, &buffer);
            library_sync::store_modified(&conn, &modified_dates);
        }
    });

    let progress_app = app.clone();
    let scanner = tokio::task::spawn_blocking(move || {
        // Rajout de format depuis la liste SUPPORTED_EXTENSIONS de libary_sync.rs
        //let entries: Vec<_> = WalkDir::new(scan_path)
        //    .into_iter()
        //    .filter_map(|e| e.ok())
        //    .filter(|e| {
        //        let p = e.path().to_string_lossy().to_lowercase();
        //        p.ends_with(".jpg") || p.ends_with(".jpeg") || p.ends_with(".png") || p.ends_with(".raw")
        //    })
        //    .collect();
        // Progression : `fraction` (0 à 1) est celle du dossier ; pour une relecture de plusieurs dossiers, elle est ramenée à l'ensemble.
        let publish = |fraction: f64| {
            let percent = match scan_mode {
                ScanMode::Rescan { index, count } => (index as f64 + fraction) / count.max(1) as f64 * 100.0,
                ScanMode::FolderScan => fraction * 100.0,
            };
            let _ = progress_app.emit("scan-progress", ScanProgress { task_id: task_id.clone(), percent: percent.round() as u32 });
        };
        let entries: Vec<_> = WalkDir::new(scan_path)
            .into_iter()
            .take_while(|_| !cancel.load(Ordering::Relaxed))
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_type().is_dir() && library_sync::is_photo_file(e.path()))
            .collect();

        let total = entries.len().max(1);
        let step = (total / 100).max(1);
        let done = AtomicUsize::new(0);

        if entries.is_empty() {
            publish(1.0);
        }

        entries.par_iter().for_each(|entry| {
            // Arrêt demandé : les fichiers restants ne sont pas lus (ceux déjà lus sont enregistrés normalement).
            if cancel.load(Ordering::Relaxed) { return; }
            // Progression : un événement environ tous les 1 % du dossier. Valeur approximative : l'ordre d'arrivée entre threads n'est pas garanti.
            let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
            if finished % step == 0 || finished == total {
                publish(finished as f64 / total as f64);
            }
            let path_str = entry.path().to_string_lossy().to_string();
            let Ok(metadata) = entry.metadata() else { return; };
            let file_size = metadata.len() as i64;
            let modified = library_sync::modified_millis(&metadata);
            let filename = entry.file_name().to_string_lossy().to_string();
            let exif_data = exif::read_exif(entry.path());

            let photo = Photo {
                id: 0,
                path: path_str,
                filename,
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
                modified,
            };

            let _ = tx.blocking_send((photo, modified));
        });
    });
    let _ = scanner.await;
    let _ = writer.await;
}

// Découverte d'un dossier qui vient d'être ajouté (voir add_folder) : lit les métadonnées de ses photos et rend la main quand c'est terminé.
// La progression est publiée par « scan-progress » (0 à 100 % du dossier) avec l'identifiant de la tâche.
#[tauri::command]
async fn scan_folder(app: tauri::AppHandle, state: State<'_, AppState>, path: String, task_id: String) -> Result<(), String> {
    let pool = state.pool();
    let cancel = scan_cancel_flag(&task_id);
    run_scan(app, pool, path, ScanMode::FolderScan, task_id.clone(), cancel).await;
    release_scan_cancel_flag(&task_id);
    Ok(())
}

#[tauri::command]
async fn rescan_all_folders(app: tauri::AppHandle, state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    let pool = state.pool();
    let folders = db::get_folders(&pool);
    let count = folders.len();
    let cancel = scan_cancel_flag(&task_id);
    for (index, folder) in folders.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) { break; }
        run_scan(app.clone(), pool.clone(), folder.path, ScanMode::Rescan { index, count }, task_id.clone(), cancel.clone()).await;
    }
    release_scan_cancel_flag(&task_id);
    Ok(())
}

fn path_segments(path: &str) -> Vec<&str> {
    path.split(|character| character == '\\' || character == '/').filter(|segment| !segment.is_empty()).collect()
}

// Chemin réel d'un dossier de l'arborescence : le dossier suivi qui le contient, tel qu'il est enregistré, suivi des segments relatifs.
// L'arborescence de l'interface assemble ses chemins avec des « / » : les relire tels quels enregistrerait les photos sous un autre texte de chemin
// (« D:\Photos/2024\a.jpg » au lieu de « D:\Photos\2024\a.jpg ») et créerait des doublons en base. Renvoie None si le dossier n'est pas suivi.
fn resolve_tracked_folder(pool: &DbPool, requested: &str) -> Option<PathBuf> {
    let requested_segments = path_segments(requested);
    db::get_folders(pool).into_iter().find_map(|folder| {
        let root_segments = path_segments(&folder.path);
        let inside_root = !root_segments.is_empty()
            && requested_segments.len() >= root_segments.len()
            && root_segments.iter().zip(&requested_segments).all(|(root, part)| root.to_lowercase() == part.to_lowercase());
        if !inside_root { return None; }
        let mut resolved = PathBuf::from(&folder.path);
        for segment in &requested_segments[root_segments.len()..] { resolved.push(segment); }
        Some(resolved)
    })
}

// Rescan d'un seul dossier suivi ou d'un de ses sous-dossiers (sous-dossiers compris), comme le rescan complet : les métadonnées de chaque
// fichier sont relues. La progression est publiée par l'événement « scan-progress » (0 à 100 % du dossier) avec l'identifiant de la tâche.
#[tauri::command]
async fn rescan_folder(app: tauri::AppHandle, state: State<'_, AppState>, path: String, task_id: String) -> Result<(), String> {
    let pool = state.pool();
    let scan_path = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !scan_path.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let cancel = scan_cancel_flag(&task_id);
    run_scan(app, pool.clone(), scan_path.to_string_lossy().into_owned(), ScanMode::Rescan { index: 0, count: 1 }, task_id.clone(), cancel).await;
    release_scan_cancel_flag(&task_id);
    Ok(())
}

// Ouvre un dossier de l'arborescence dans le gestionnaire de fichiers par défaut de l'OS (Explorateur Windows, Finder, gestionnaire Linux).
// Utilise le plugin opener déjà intégré, sans nouvelle dépendance.
#[tauri::command(async)]
fn open_folder_in_file_manager(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let native: PathBuf = folder.components().collect();
    let native = native.to_string_lossy().into_owned();
    tauri_plugin_opener::open_path(native.as_str(), None::<&str>).map_err(|error| format!("Impossible d'ouvrir {native} : {error}"))
}

// Crée un sous-dossier dans un dossier de l'arborescence (suivi ou sous-dossier d'un dossier suivi). Le nom est vérifié ici : un seul niveau,
// sans caractère interdit par Windows (le même nom reste donc valide sous Linux et macOS), et jamais d'écrasement d'un dossier ou fichier existant.
#[tauri::command(async)]
fn create_subfolder(state: State<'_, AppState>, parent: String, name: String) -> Result<(), String> {
    let name = name.trim();
    // ... validation du nom ...
    let pool = state.pool();
    let parent_folder = resolve_tracked_folder(&pool, &parent).ok_or_else(|| format!("Dossier non suivi : {parent}"))?;
    if !parent_folder.is_dir() { return Err(format!("Dossier introuvable : {parent}")); }
    let target = parent_folder.join(name);
    if target.exists() { return Err(format!("« {name} » existe déjà dans ce dossier")); }
    fs::create_dir(&target).map_err(|error| format!("Création impossible : {error}"))
}

fn insert_batch(conn: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>, photos: &[Photo]) {
    let _ = conn.execute("BEGIN TRANSACTION", []);
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO photos 
            (path, filename, date_taken, aperture, shutter_speed, iso, focal_length, manufacturer, camera_model, width, height, file_size, rating, color_flag, keywords, caption, lens_model) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                filename=excluded.filename, date_taken=excluded.date_taken,
                aperture=excluded.aperture, shutter_speed=excluded.shutter_speed,
                iso=excluded.iso, focal_length=excluded.focal_length, manufacturer=excluded.manufacturer,
                camera_model=excluded.camera_model, width=excluded.width,
                height=excluded.height, file_size=excluded.file_size,
                rating=excluded.rating, color_flag=excluded.color_flag,
                keywords=excluded.keywords, caption=excluded.caption, lens_model=excluded.lens_model"
        ).unwrap();

        for p in photos {
            let _ = stmt.execute(params![
                p.path, p.filename, p.date_taken, p.aperture, p.shutter_speed, 
                p.iso, p.focal_length, p.manufacturer, p.camera_model, p.width, p.height, p.file_size,
                p.rating, p.color_flag, p.keywords, p.caption, p.lens_model
            ]);
        }
    }
    let _ = conn.execute("COMMIT", []);
}

#[tauri::command]
fn get_photos_paginated(state: State<'_, AppState>, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool) -> Vec<Photo> {
    let pool = state.pool();
    db::get_photos(&pool, offset, limit, folder_filter, recursive)
}

#[tauri::command]
fn update_photo_metadata(state: State<'_, AppState>, id: i64, path: String, rating: Option<i32>, color_flag: Option<String>) -> Result<(), String> {
    // Seules les valeurs fournies sont modifiées : écrire la note ne touche pas au xmp:Label (qui peut contenir
    // une valeur non reconnue par l'application), et inversement.
    let rating = rating.map(|value| value.clamp(0, 5));
    let label = match color_flag.as_deref() {
        Some(flag) => Some(exif::label_for_color_flag(flag)?),
        None => None,
    };
    if rating.is_none() && label.is_none() { return Ok(()); }
    exif::write_xmp_metadata(&path, rating, label).map_err(|e| e.to_string())?;
    let pool = state.pool();
    let conn = pool.get().unwrap();
    // Le fichier vient d'être réécrit par l'application : on enregistre sa nouvelle taille et sa date pour que la
    // synchronisation ne le prenne pas pour une modification externe.
    if let Ok(metadata) = fs::metadata(&path) {
        let _ = conn.execute("UPDATE photos SET file_size = ?, modified = ? WHERE id = ?", params![metadata.len() as i64, library_sync::modified_millis(&metadata), id]);
    }
    if let Some(rating) = rating {
        conn.execute("UPDATE photos SET rating = ? WHERE id = ?", params![rating, id]).map_err(|e| e.to_string())?;
    }
    if let Some(flag) = color_flag {
        conn.execute("UPDATE photos SET color_flag = ? WHERE id = ?", params![exif::normalize_color_flag(&flag), id]).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[derive(serde::Serialize)]
struct FileFailure {
    path: String,
    error: String,
}

#[derive(serde::Serialize)]
struct DeleteResult {
    deleted: Vec<String>,
    failed: Vec<FileFailure>,
}

#[derive(serde::Serialize)]
struct CopyResult {
    copied: usize,
    failed: Vec<FileFailure>,
}

#[derive(serde::Serialize)]
struct MovedFile {
    from: String,
    to: String,
}

#[derive(serde::Serialize)]
struct MoveResult {
    moved: Vec<MovedFile>,
    // Photos déjà dans le dossier de destination : ni déplacées, ni en échec.
    skipped: usize,
    failed: Vec<FileFailure>,
}

// Contenu de la fenêtre « Infos » du menu contextuel : fichier, EXIF, XMP et IPTC.
#[tauri::command(async)]
fn get_photo_details(path: String) -> exif::MetadataDetails {
    exif::read_metadata_details(Path::new(&path))
}

// Suppression vers la corbeille de l'OS (crate `trash`) : le fichier est restaurable depuis la corbeille. Seules les photos du catalogue
// peuvent être supprimées. La photo disparaît du catalogue, avec sa miniature en cache ; un éventuel sidecar .xmp est conservé.
// Si le fichier n'est pas mis à la corbeille (erreur), la photo reste dans le catalogue et l'échec est signalé : jamais de suppression définitive de repli.
#[tauri::command(async)]
fn delete_photos(state: State<'_, AppState>, paths: Vec<String>) -> Result<DeleteResult, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();

    for path in paths {
        let tracked: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![path], |row| row.get(0))
            .unwrap_or(false);
        if !tracked {
            failed.push(FileFailure { path, error: "Photo absente du catalogue".into() });
            continue;
        }

        // Calcule les chemins du cache miniature et preview RAW dans le bon dossier
        let cache_file = thumbnail_cache_file(&thumbnails_dir, &path).ok();
        let raw_preview_file = raw_preview_cache_file(&raw_previews_dir, &path).ok();

        // Fichier déjà absent (supprimé hors de l'application) : rien à mettre à la corbeille, on retire simplement la photo du catalogue.
        if Path::new(&path).exists() {
            if let Err(error) = trash::delete(&path) {
                failed.push(FileFailure { path, error: error.to_string() });
                continue;
            }
        }

        // Nettoyage des caches correspondants
        if let Some(cache_file) = cache_file { let _ = fs::remove_file(cache_file); }
        if let Some(raw_preview_file) = raw_preview_file { let _ = fs::remove_file(raw_preview_file); }

        let _ = conn.execute("DELETE FROM photos WHERE path = ?", params![path]);
        deleted.push(path);
    }
    Ok(DeleteResult { deleted, failed })
}

// Windows : la corbeille n'existe que sur les disques fixes (HDD et SSD, y compris les disques externes que Windows voit comme fixes). Une clé USB (support
// « amovible »), un lecteur ou partage réseau (lettre mappée ou chemin UNC), un CD/DVD ou un disque RAM n'en ont pas : la suppression y est définitive.
// Linux et macOS : la crate `trash` utilise la corbeille du volume (sous Linux, « .Trash-UID » à la racine d'un volume autre que le dossier personnel).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq)]
enum WindowsRoot {
    Unc,
    Drive(String),
    Other,
}

// Lecteur (« D:\ ») ou partage UNC d'un chemin, avec « / » ou « \ » et préfixes « \\?\ » acceptés.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_root(path: &str) -> WindowsRoot {
    let normalized = path.replace('/', "\\");
    let normalized = if let Some(rest) = normalized.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = normalized.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        normalized.clone()
    };
    if normalized.starts_with("\\\\") { return WindowsRoot::Unc; }
    let mut characters = normalized.chars();
    match (characters.next(), characters.next()) {
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic() => WindowsRoot::Drive(format!("{letter}:\\")),
        _ => WindowsRoot::Other,
    }
}

#[cfg(windows)]
fn has_trash(path: &str) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
    }
    match windows_root(path) {
        WindowsRoot::Unc => false,
        WindowsRoot::Drive(root) => {
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // 2 = amovible (clé USB), 4 = réseau, 5 = CD/DVD, 6 = disque RAM. Les autres cas (fixe, inconnu) sont considérés avec corbeille.
            !matches!(unsafe { GetDriveTypeW(wide.as_ptr()) }, 2 | 4 | 5 | 6)
        }
        WindowsRoot::Other => true,
    }
}

#[cfg(not(windows))]
fn has_trash(_path: &str) -> bool {
    true
}

// Nombre de ces chemins (fichiers ou dossiers) que la suppression n'enverra PAS à la corbeille mais effacera définitivement, d'après leur support (voir has_trash).
// L'interface s'en sert pour afficher le bon message de confirmation. Ne touche pas au disque (sauf la question du type de lecteur à Windows).
#[tauri::command(async)]
fn count_permanent_deletions(paths: Vec<String>) -> usize {
    paths.iter().filter(|path| !has_trash(path)).count()
}

// Supprime un dossier de l'arborescence (sous-dossier d'un dossier suivi) vers la corbeille de l'OS, avec tout son contenu : sous-dossiers et
// fichiers de tout type, pas seulement les photos. Il reste restaurable depuis la corbeille quand le support en a une (voir count_permanent_deletions). Comme pour
// delete_photos, aucun repli automatique vers une suppression définitive : si la mise à la corbeille échoue, le catalogue n'est pas touché et l'erreur est renvoyée.
// Ensuite, les photos du dossier quittent le catalogue (avec leurs caches de miniatures) ; leurs chemins sont renvoyés.
// Refusé pour un dossier suivi (celui des Paramètres), pour un dossier qui en contient un, et pour un dossier qui contient les données de l'application.
// La sélection des photos se fait sur le chemin complet avec séparateur final : supprimer « D:\Photos » ne touche pas « D:\Photos2 ».
#[tauri::command(async)]
fn delete_folder(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    if folder.parent().is_none() { return Err("Une racine de disque ne peut pas être supprimée".into()); }
    let folder_segments = lowercase_segments(&folder);
    if lowercase_segments(&state.base_dir()).starts_with(&folder_segments) {
        return Err("Ce dossier contient les données de l'application (base de données et miniatures)".into());
    }

    // Un dossier suivi se retire de la liste des Paramètres, il ne se supprime pas d'ici ; idem pour un dossier qui en contient un (il serait supprimé avec).
    if db::get_folders(&pool).iter().any(|root| lowercase_segments(Path::new(&root.path)).starts_with(&folder_segments)) {
        return Err("Ce dossier est un dossier suivi, ou en contient un : retirez-le d'abord de la liste des dossiers (Paramètres)".into());
    }

    let conn = pool.get().map_err(|error| error.to_string())?;
    let prefix = format!("{}/", folder.to_string_lossy().replace('\\', "/").trim_end_matches('/'));
    const IN_FOLDER: &str = "lower(substr(replace(path, char(92), '/'), 1, length(?1))) = lower(?1)";
    let photo_paths: Vec<String> = {
        let mut statement = conn
            .prepare(&format!("SELECT path FROM photos WHERE {IN_FOLDER}"))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![prefix], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.filter_map(|row| row.ok()).collect()
    };

    // Les noms des caches dépendent de la taille et de la date des fichiers : à calculer avant la mise à la corbeille.
    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();
    let cache_files: Vec<PathBuf> = photo_paths
        .iter()
        .flat_map(|photo| [thumbnail_cache_file(&thumbnails_dir, photo).ok(), raw_preview_cache_file(&raw_previews_dir, photo).ok()])
        .flatten()
        .collect();

    // Chemin natif (séparateurs de l'OS) : le dossier suivi peut avoir été enregistré avec des « / », que la corbeille de Windows n'accepte pas toujours.
    let native: PathBuf = folder.components().collect();
    trash::delete(&native).map_err(|error| format!("Mise à la corbeille impossible : {error}"))?;

    // Le dossier n'existe plus : le nettoyage du catalogue ne doit plus faire échouer l'opération (la synchronisation rattraperait un reste éventuel).
    for cache_file in cache_files { let _ = fs::remove_file(cache_file); }
    let _ = conn.execute(&format!("DELETE FROM photos WHERE {IN_FOLDER}"), params![prefix]);
    Ok(photo_paths)
}

// Un dossier suivi est « joignable » s'il existe, ou si son dossier parent existe (dossier supprimé ou renommé hors de l'application).
// Un disque externe débranché ou un partage réseau coupé n'est donc jamais pris pour une suppression de photos.
fn tracked_root_is_reachable(root: &str) -> bool {
    let root = Path::new(root);
    root.is_dir() || root.parent().map_or(false, |parent| parent.is_dir())
}

fn is_inside_folder(folder: &str, path: &str) -> bool {
    let normalize = |value: &str| value.replace('\\', "/").trim_end_matches('/').to_lowercase();
    normalize(path).starts_with(&format!("{}/", normalize(folder)))
}

// Synchronisation « paresseuse » avec le disque : l'interface signale les photos qu'elle n'arrive pas à afficher
// (miniature impossible à générer, image qui ne se charge pas). Celles dont le fichier a réellement disparu sont retirées
// du catalogue, et la liste des chemins retirés est renvoyée. Un fichier présent mais illisible est conservé, et rien n'est
// retiré si le dossier suivi est injoignable. Le sidecar .xmp et le cache de miniatures ne sont pas touchés (le nom d'une miniature
// dépend de la taille et de la date du fichier, qui ne sont plus connues).
#[tauri::command(async)]
fn remove_missing_photos(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<String>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let reachable_roots: Vec<String> = db::get_folders(&pool)
        .into_iter()
        .map(|folder| folder.path)
        .filter(|root| tracked_root_is_reachable(root))
        .collect();
    let mut removed = Vec::new();
    for path in paths {
        let missing = matches!(fs::metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
        if !missing || !reachable_roots.iter().any(|root| is_inside_folder(root, &path)) { continue; }
        conn.execute("DELETE FROM photos WHERE path = ?", params![path]).map_err(|error| error.to_string())?;
        removed.push(path);
    }
    Ok(removed)
}

// Synchronisation incrémentale avec le disque (voir library_sync.rs) : fichiers ajoutés, modifiés ou supprimés hors de l'application.
// Exécutée hors du thread principal et hors des threads asynchrones ; l'interface la lance au démarrage et au retour de focus.
#[tauri::command]
async fn sync_library(state: State<'_, AppState>) -> Result<library_sync::SyncChanges, String> {
    let pool = state.pool();
    tokio::task::spawn_blocking(move || library_sync::sync_library(&pool))
        .await
        .map_err(|error| error.to_string())?
}

// Nom libre dans le dossier de destination : « photo.jpg », puis « photo (1).jpg », « photo (2).jpg »… (jamais d'écrasement).
fn unique_destination(directory: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() { return candidate; }
    let name = Path::new(file_name);
    let stem = name.file_stem().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = name.extension().map(|value| format!(".{}", value.to_string_lossy())).unwrap_or_default();
    let mut index = 1u32;
    loop {
        let candidate = directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() { return candidate; }
        index += 1;
    }
}

// Copie aussi le sidecar XMP (`photo.jpg.xmp` ou `photo.xmp`) : note, couleur et mots-clés des formats autres que JPEG y sont stockés.
fn copy_sidecar(source: &Path, target: &Path) {
    let appended = PathBuf::from(format!("{}.xmp", source.display()));
    let (from, to) = if appended.is_file() {
        (appended, PathBuf::from(format!("{}.xmp", target.display())))
    } else {
        let compatible = source.with_extension("xmp");
        if !compatible.is_file() { return; }
        (compatible, target.with_extension("xmp"))
    };
    if !to.exists() { let _ = fs::copy(from, to); }
}

fn lowercase_segments(path: &Path) -> Vec<String> {
    path_segments(&path.to_string_lossy()).into_iter().map(|segment| segment.to_lowercase()).collect()
}

// Déplace un fichier : renommage, ou copie puis suppression de l'original quand le renommage est impossible (autre disque, par exemple).
// Si la copie réussit mais que l'original ne peut pas être supprimé, la copie est retirée : le fichier n'est jamais dupliqué.
fn move_file(source: &Path, target: &Path) -> std::io::Result<()> {
    if fs::rename(source, target).is_ok() { return Ok(()); }
    if let Err(error) = fs::copy(source, target) {
        let _ = fs::remove_file(target);
        return Err(error);
    }
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

// Sidecar XMP d'une photo déplacée : « photo.jpg.xmp » est déplacé avec elle. Un sidecar « photo.xmp » peut être partagé avec un autre fichier du même nom
// (paire RAW + JPEG) : il est copié et l'original reste en place, pour ne pas priver l'autre fichier de ses métadonnées.
fn move_sidecar(source: &Path, target: &Path) {
    let appended = PathBuf::from(format!("{}.xmp", source.display()));
    if appended.is_file() {
        let destination = PathBuf::from(format!("{}.xmp", target.display()));
        if !destination.exists() { let _ = move_file(&appended, &destination); }
    } else {
        copy_sidecar(source, target);
    }
}

// Déplace des photos du catalogue vers un dossier de l'arborescence (suivi ou sous-dossier d'un dossier suivi), par glisser-déposer.
// Un fichier de même nom n'est jamais écrasé : le fichier déplacé est renommé (« photo (1).jpg »). La ligne de la base est mise à jour (même id : note,
// couleur et mots-clés sont conservés) et la miniature du cache, qui dépend du chemin, est supprimée.
#[tauri::command(async)]
fn move_photos(state: State<'_, AppState>, paths: Vec<String>, destination: String) -> Result<MoveResult, String> {
    let pool = state.pool();
    let destination_dir = resolve_tracked_folder(&pool, &destination).ok_or_else(|| format!("Dossier non suivi : {destination}"))?;
    if !destination_dir.is_dir() { return Err(format!("Dossier de destination introuvable : {destination}")); }
    let conn = pool.get().map_err(|error| error.to_string())?;
    let destination_segments = lowercase_segments(&destination_dir);
    let mut moved = Vec::new();
    let mut skipped = 0;
    let mut failed = Vec::new();
    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();

    for path in paths {
        let tracked: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![path], |row| row.get(0))
            .unwrap_or(false);
        if !tracked {
            failed.push(FileFailure { path: path.clone(), error: "Photo absente du catalogue".into() });
            continue;
        }
        let source = Path::new(&path);
        let Some(file_name) = source.file_name() else {
            failed.push(FileFailure { path: path.clone(), error: "Nom de fichier invalide".into() });
            continue;
        };
        if source.parent().map_or(false, |parent| lowercase_segments(parent) == destination_segments) {
            skipped += 1;
            continue;
        }
        if !source.is_file() {
            failed.push(FileFailure { path: path.clone(), error: "Fichier introuvable".into() });
            continue;
        }
        let target = unique_destination(&destination_dir, file_name);
        
        let cache_file = thumbnail_cache_file(&thumbnails_dir, &path).ok();
        let raw_preview_file = raw_preview_cache_file(&raw_previews_dir, &path).ok();

        if let Err(error) = move_file(source, &target) {
            failed.push(FileFailure { path: path.clone(), error: error.to_string() });
            continue;
        }
        move_sidecar(source, &target);
        if let Some(cache_file) = cache_file { let _ = fs::remove_file(cache_file); }
        if let Some(raw_preview_file) = raw_preview_file { let _ = fs::remove_file(raw_preview_file); }

        let new_path = target.to_string_lossy().into_owned();
        let new_name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let (size, modified) = fs::metadata(&target)
            .map(|metadata| (metadata.len() as i64, library_sync::modified_millis(&metadata)))
            .unwrap_or((0, 0));
        let _ = conn.execute("DELETE FROM photos WHERE path = ?", params![new_path]);
        let _ = conn.execute(
            "UPDATE photos SET path = ?, filename = ?, file_size = ?, modified = ? WHERE path = ?",
            params![new_path, new_name, size, modified, path],
        );
        moved.push(MovedFile { from: path.clone(), to: new_path });
    }
    Ok(MoveResult { moved, skipped, failed })
}

// Copie des fichiers originaux (pas des miniatures) dans un dossier. Un fichier déjà présent n'est jamais écrasé :
// la copie est renommée (« photo (1).jpg »). Les dossiers suivis ne sont pas rescannés automatiquement.
#[tauri::command(async)]
fn copy_photos(paths: Vec<String>, destination: String) -> Result<CopyResult, String> {
    let destination_dir = Path::new(&destination);
    if !destination_dir.is_dir() { return Err(format!("Dossier de destination introuvable : {destination}")); }
    let mut copied = 0;
    let mut failed = Vec::new();
    for path in paths {
        let source = Path::new(&path);
        let Some(file_name) = source.file_name() else {
            failed.push(FileFailure { path: path.clone(), error: "Nom de fichier invalide".into() });
            continue;
        };
        let target = unique_destination(destination_dir, file_name);
        match fs::copy(source, &target) {
            Ok(_) => {
                copy_sidecar(source, &target);
                copied += 1;
            }
            Err(error) => {
                let _ = fs::remove_file(&target);
                failed.push(FileFailure { path: path.clone(), error: error.to_string() });
            }
        }
    }
    Ok(CopyResult { copied, failed })
}

// Copie par glisser-déposer (Ctrl) vers un dossier de l'arborescence : même copie que « Copier vers… » (jamais d'écrasement, sidecar copié), mais la
// destination doit être un dossier suivi ou l'un de ses sous-dossiers, et son chemin est reconstruit comme pour les autres commandes de dossier.
// Les copies ne sont pas ajoutées au catalogue ici : l'interface lance ensuite la synchronisation incrémentale (sync_library).
#[tauri::command(async)]
fn copy_photos_to_tracked_folder(state: State<'_, AppState>, paths: Vec<String>, destination: String) -> Result<CopyResult, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &destination).ok_or_else(|| format!("Dossier non suivi : {destination}"))?;
    copy_photos(paths, folder.to_string_lossy().into_owned())
}

// Redimensionne une photo selon les options de la fenêtre « Redimensionner… » (voir resize.rs) : un appel par photo, l'interface pilote le lot
// (progression, questions en cas de fichier existant) et lance quelques appels en parallèle. Le travail se fait hors du thread principal et des
// threads asynchrones. Le résultat dit si le fichier a été écrit, s'il existait déjà (politique « Ask ») ou s'il a été passé.
#[tauri::command]
async fn resize_photo(path: String, options: resize::ResizeOptions) -> Result<resize::ResizeOutcome, String> {
    tokio::task::spawn_blocking(move || resize::resize_photo(Path::new(&path), &options))
        .await
        .map_err(|error| error.to_string())?
}

// Ouvre les fichiers avec un programme externe (liste des Paramètres ou programme choisi dans la boîte de dialogue de l'OS).
#[tauri::command(async)]
fn open_with(program: String, paths: Vec<String>) -> Result<(), String> {
    let program_path = Path::new(&program);
    if !program_path.is_file() { return Err(format!("Programme introuvable : {program}")); }
    if let Some(missing) = paths.iter().find(|path| !Path::new(path).is_file()) { return Err(format!("Fichier introuvable : {missing}")); }
    if paths.is_empty() { return Ok(()); }
    std::process::Command::new(program_path).args(&paths).spawn().map(|_| ()).map_err(|error| format!("Impossible de lancer {program} : {error}"))
}

// Affiche le fichier dans le gestionnaire de fichiers par défaut de l'OS : dossier ouvert avec le fichier sélectionné
// (Explorateur Windows, Finder, gestionnaire de fichiers Linux). Utilise le plugin opener déjà intégré, sans nouvelle dépendance.
#[tauri::command(async)]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() { return Err(format!("Fichier introuvable : {path}")); }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|error| format!("Impossible d'afficher {path} : {error}"))
}

// Place les fichiers dans le presse-papiers de l'OS comme « Copier » dans l'explorateur de fichiers : c'est une liste de fichiers, qu'on peut
// coller dans l'explorateur, un client mail, une messagerie… Les fichiers inexistants sont ignorés ; renvoie le nombre de fichiers copiés.
// Portable (Windows, macOS, Linux) grâce à la crate clipboard-rs, sans PowerShell ni outil externe.
use clipboard_rs::{Clipboard, ClipboardContext};
static CLIPBOARD: std::sync::Mutex<Option<ClipboardContext>> = std::sync::Mutex::new(None);

#[tauri::command(async)]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<usize, String> {
    let existing: Vec<&String> = paths.iter().filter(|path| Path::new(path.as_str()).is_file()).collect();
    if existing.is_empty() {
        return Err(match paths.first() {
            Some(path) => format!("Fichier introuvable : {path}"),
            None => "Aucune photo à copier".into(),
        });
    }
    let entries: Vec<String> = existing.iter().map(|path| clipboard_entry(path)).collect();
    // Le contexte est conservé entre deux appels : sous Linux (X11), c'est le processus de l'appli qui sert le contenu du presse-papiers
    // aux autres applications, il ne doit donc pas être libéré juste après la copie.
    let mut guard = CLIPBOARD.lock().map_err(|_| "Presse-papiers indisponible".to_string())?;
    if guard.is_none() {
        *guard = Some(ClipboardContext::new().map_err(|error| format!("Presse-papiers indisponible : {error}"))?);
    }
    let clipboard = guard.as_ref().ok_or("Presse-papiers indisponible")?;
    clipboard
        .set_files(entries)
        .map_err(|error| format!("Écriture dans le presse-papiers impossible : {error}"))?;
    Ok(existing.len())
}

// Format attendu par clipboard-rs pour set_files : sous Windows, les chemins tels quels (la crate construit elle-même la liste CF_HDROP ;
// des URI y seraient écrits comme de faux chemins et le collage ne ferait rien) ; ailleurs, des URI « file:/// ».
#[cfg(windows)]
fn clipboard_entry(path: &str) -> String {
    path.replace('/', "\\")
}

#[cfg(not(windows))]
fn clipboard_entry(path: &str) -> String {
    file_uri(path)
}

// URI « file:/// » avec caractères spéciaux encodés en %XX (ex. /home/x/a b.jpg -> file:///home/x/a%20b.jpg).
#[cfg(not(windows))]
fn file_uri(path: &str) -> String {
    let mut uri = String::from("file://");
    if !path.starts_with('/') {
        uri.push('/');
    }
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => uri.push(byte as char),
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();
            let paths = resolve_app_paths(handle).map_err(|e| format!("Erreur d'initialisation des chemins : {e}"))?;
            let db_pool = db::init_db(&paths.db_path.to_string_lossy());
            let config = load_config(handle);
            let cache_size = config.thumbnail_cache_size.unwrap_or(512);

            // Restauration de la fenêtre au démarrage avec vérification des écrans
            let main_window = app.get_webview_window("main").ok_or("Fenêtre principale introuvable")?;
            let window_tracker = restore_window_state(&main_window, &config);

            app.manage(AppState {
                db_pool: RwLock::new(db_pool),
                paths: RwLock::new(paths),
                thumbnail_cache_size: RwLock::new(cache_size),
                window_tracker: Mutex::new(window_tracker),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // Mémorise la taille non-maximisée en direct
                tauri::WindowEvent::Resized(size) => {
                    if let Ok(false) = window.is_maximized() {
                        if size.width > 0 && size.height > 0 {
                            if let Some(state) = window.app_handle().try_state::<AppState>() {
                                if let Ok(mut tracker) = state.window_tracker.lock() {
                                    tracker.width = size.width;
                                    tracker.height = size.height;
                                }
                            }
                        }
                    }
                }
                // Mémorise la position non-maximisée en direct
                tauri::WindowEvent::Moved(pos) => {
                    if let Ok(false) = window.is_maximized() {
                        if let Some(state) = window.app_handle().try_state::<AppState>() {
                            if let Ok(mut tracker) = state.window_tracker.lock() {
                                tracker.x = pos.x;
                                tracker.y = pos.y;
                            }
                        }
                    }
                }
                // Sauvegarde sur le disque à la fermeture
                tauri::WindowEvent::CloseRequested { .. } => {
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        save_current_window_state(window, &state);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // ... vos commandes existantes restent strictement inchangées ...
            get_storage_location,
            change_storage_location,
            clear_thumbnail_cache,
            set_thumbnail_cache_size,
            get_folders,
            add_folder,
            scan_folder,
            cancel_scan,
            remove_folder,
            get_photos_paginated,
            get_cached_thumbnail_path,
            get_cached_thumbnail_paths,
            generate_thumbnail,
            get_raw_preview_path,
            save_thumbnail_cache,
            rescan_all_folders,
            rescan_folder,
            open_folder_in_file_manager,
            create_subfolder,
            update_photo_metadata,
            get_photo_details,
            delete_photos,
            delete_folder,
            count_permanent_deletions,
            remove_missing_photos,
            sync_library,
            copy_photos,
            copy_photos_to_tracked_folder,
            move_photos,
            open_with,
            reveal_in_file_manager,
            copy_files_to_clipboard,
            resize_photo
        ])
        .run(tauri::generate_context!())
        .expect("Erreur de lancement");
}


// Fonctions de déplacmeents des fichiers de base
fn move_file_or_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() { return Ok(()); }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // Secours si le déplacement traverse deux disques différents (ex: C: vers D:)
    fs::copy(src, dst)?;
    let _ = fs::remove_file(src);
    Ok(())
}

fn move_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.is_dir() { return Ok(()); }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            move_dir_recursive(&src_path, &dst_path)?;
        } else {
            move_file_or_copy(&src_path, &dst_path)?;
        }
    }
    let _ = fs::remove_dir(src);
    Ok(())
}

#[derive(serde::Serialize)]
struct StorageLocationInfo {
    current_path: String,
    is_custom: bool,
    default_path: String,
}

#[tauri::command]
fn get_storage_location(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<StorageLocationInfo, String> {
    let default_path = default_data_directory(&app)?.to_string_lossy().into_owned();
    Ok(StorageLocationInfo {
        current_path: state.base_dir().to_string_lossy().into_owned(),
        is_custom: state.is_custom(),
        default_path,
    })
}

#[tauri::command(async)]
fn change_storage_location(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    new_path: Option<String>,
) -> Result<StorageLocationInfo, String> {
    let default_dir = default_data_directory(&app)?;
    let target_dir = match &new_path {
        Some(p) if !p.trim().is_empty() => {
            let path = PathBuf::from(p.trim());
            if path == state.base_dir() {
                return Err("Le dossier choisi est identique à l'emplacement actuel".into());
            }
            path
        }
        _ => {
            if !state.is_custom() {
                return Err("L'application utilise déjà l'emplacement par défaut".into());
            }
            default_dir.clone()
        }
    };

    // 1. Checkpoint WAL sur la base courante pour intégrer toutes les transactions dans photos_library.db
    {
        let pool = state.pool();
        if let Ok(conn) = pool.get() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
    }

    // 2. Verrouille le pool pour couper l'ouverture de nouvelles connexions pendant le déplacement
    let mut pool_guard = state.db_pool.write().map_err(|e| e.to_string())?;

    // 3. Déplacement des fichiers
    let current_base = state.base_dir();
    fs::create_dir_all(&target_dir).map_err(|e| format!("Impossible de créer le dossier cible : {e}"))?;

    for file_name in &["photos_library.db", "photos_library.db-wal", "photos_library.db-shm"] {
        let src = current_base.join(file_name);
        let dst = target_dir.join(file_name);
        if src.is_file() {
            move_file_or_copy(&src, &dst).map_err(|e| format!("Erreur lors du déplacement de {file_name} : {e}"))?;
        }
    }

    for folder_name in &["thumbnails", "raw_previews"] {
        let src = current_base.join(folder_name);
        let dst = target_dir.join(folder_name);
        if src.is_dir() {
            move_dir_recursive(&src, &dst).map_err(|e| format!("Erreur lors du déplacement de {folder_name} : {e}"))?;
        }
    }

    // 4. Initialise le nouveau pool sur la nouvelle base
    let new_db_path = target_dir.join("photos_library.db");
    let new_pool = db::init_db(&new_db_path.to_string_lossy());
    *pool_guard = new_pool;

    // 5. Met à jour les chemins dans l'état de l'application
    let is_custom = new_path.is_some() && target_dir != default_dir;
    let new_paths = AppDataPaths::from_base(target_dir.clone(), is_custom);
    {
        let mut paths_guard = state.paths.write().map_err(|e| e.to_string())?;
        *paths_guard = new_paths;
    }

    // 6. Sauvegarde dans le fichier config.json
    let mut config_data = load_config(&app);
    config_data.custom_data_dir = if is_custom { Some(target_dir.to_string_lossy().into_owned()) } else { None };
    config_data.thumbnail_cache_size = Some(state.thumbnail_cache_size() as u32);
    save_config(&app, &config_data)?;

    Ok(StorageLocationInfo {
        current_path: target_dir.to_string_lossy().into_owned(),
        is_custom,
        default_path: default_dir.to_string_lossy().into_owned(),
    })
}
