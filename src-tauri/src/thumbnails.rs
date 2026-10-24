//! Génération des miniatures du cache en Rust (JPEG uniquement).
//!
//! Le décodage utilise la réduction d'échelle DCT de `jpeg-decoder` (1/2, 1/4 ou 1/8 selon la taille demandée) :
//! une photo de 24 Mpx n'est jamais décodée en pleine résolution. Le redimensionnement final est une moyenne
//! par aires, l'orientation EXIF est appliquée sur la petite image, puis le résultat est écrit en JPEG.
//! Pour les RAW, on ne fait jamais de décodage, on utilise le jpeg intégré aussi bien pour les miniatures que pour le plein écran
//! Tout ce qui n'est pas géré (PNG, JPEG CMYK ou 16 bits, fichier corrompu…) renvoie une erreur :
//! l'interface utilise alors son ancienne génération dans le webview.

use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use exif::{In, Reader, Tag};
use jpeg_decoder::{Decoder, PixelFormat};
use jpeg_encoder::{ColorType, Encoder};

/// Plus grand côté des miniatures du cache (identique à l'ancienne génération côté interface).
//pub const THUMBNAIL_MAX_SIDE: usize = 512;
const THUMBNAIL_JPEG_QUALITY: u8 = 84;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Dimensions d'une miniature (orientation EXIF appliquée).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThumbnailSize {
    pub width: u32,
    pub height: u32,
}

/// Génère la miniature JPEG de `source` dans `destination` à la taille maximale spécifiée.
pub fn generate_thumbnail(source: &Path, destination: &Path, max_side: usize) -> Result<ThumbnailSize, String> {
    let (rgb, width, height) = decode_scaled_rgb(source, max_side)?;
    let (rgb, width, height) = resize_to_fit(rgb, width, height, max_side);
    // HEIC / HEIF : le décodeur a déjà appliqué la rotation du conteneur, l'orientation EXIF ne doit pas l'être une seconde fois.
    let orientation = if crate::heif::is_heif_path(source) { 1 } else { read_orientation(source) };
    let (rgb, width, height) = apply_orientation(rgb, width, height, orientation);
    write_jpeg(destination, &rgb, width, height)?;
    Ok(ThumbnailSize { width: width as u32, height: height as u32 })
}

/// Dimensions d'une miniature déjà présente dans le cache (lecture de l'en-tête uniquement).
pub fn jpeg_size(path: &Path) -> Result<ThumbnailSize, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut decoder = Decoder::new(BufReader::new(file));
    decoder.read_info().map_err(|error| format!("Miniature illisible : {error}"))?;
    let info = decoder.info().ok_or("En-tête JPEG absent")?;
    Ok(ThumbnailSize { width: info.width as u32, height: info.height as u32 })
}

//// Tentative de decodage extraction preview raw
use std::io::{Cursor, Read, Seek, SeekFrom};

///////
/// EXTRACTEURS RAW
///////

/// Extrait le flux JPEG de prévisualisation contenu dans un fichier RAW.
pub fn extract_raw_preview(source: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(source).map_err(|e| e.to_string())?;
    let mut header = [0u8; 16];
    let n = file.read(&mut header).map_err(|e| e.to_string())?;
    if n < 16 {
        return Err("Fichier RAW trop court".into());
    }

    // 1. Cas spécifique : Fujifilm RAF
    if header.starts_with(b"FUJIFILMCCD-RAW") {
        file.seek(SeekFrom::Start(0x54)).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 8];
        file.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let offset = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64;
        let length = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
        if offset > 0 && length > 1000 {
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            let mut jpeg_data = vec![0u8; length];
            file.read_exact(&mut jpeg_data).map_err(|e| e.to_string())?;
            if jpeg_data.starts_with(&[0xff, 0xd8]) {
                return Ok(jpeg_data);
            }
        }
    }

    // 2. Cas spécifique : Canon CR3 (conteneur ISO BMFF)
    // Recherche de la boîte PRVW dans les premiers mégaoctets
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "cr3" {
        if let Ok(jpeg) = find_cr3_preview(&mut file) {
            return Ok(jpeg);
        }
    }

    // 3. Fichiers basés sur TIFF (ARW, CR2, NEF, DNG, ORF, RW2) et fallback universel
    // On scanne les premiers 8 Mo pour localiser le JPEG de prévisualisation (commence par FF D8 FF)
    find_embedded_jpeg_stream(&mut file)
}

/// Recherche un flux JPEG intégré dans le fichier (méthode rapide par segments de 512 Ko)
fn find_embedded_jpeg_stream(file: &mut File) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    // La plupart des previews RAW sont dans les 12 premiers mégaoctets
    let max_search: usize = 12 * 1024 * 1024;
    let mut buffer = Vec::with_capacity(max_search);
    file.take(max_search as u64).read_to_end(&mut buffer).map_err(|e| e.to_string())?;

    let mut largest_jpeg: Option<(usize, usize)> = None; // (offset, approx_len)
    let mut i = 0;
    while i + 4 <= buffer.len() {
        // Marqueur de début de JPEG (SOI) suivi d'un marqueur valide (APP0..APP15 ou DQT ou SOF)
        if buffer[i] == 0xff && buffer[i + 1] == 0xd8 && buffer[i + 2] == 0xff {
            let marker = buffer[i + 3];
            if (0xe0..=0xef).contains(&marker) || marker == 0xdb || marker == 0xc0 || marker == 0xc2 {
                let start = i;
                // Trouver la fin du JPEG (EOI : FF D9)
                let mut end = start + 4;
                while end + 2 <= buffer.len() {
                    if buffer[end] == 0xff && buffer[end + 1] == 0xd9 {
                        end += 2;
                        break;
                    }
                    end += 1;
                }
                let len = end - start;
                // On privilégie une image d'au moins 20 Ko pour éviter les minuscules icônes 160x120
                if len >= 20_000 {
                    if let Some((_, best_len)) = largest_jpeg {
                        if len > best_len {
                            largest_jpeg = Some((start, len));
                        }
                    } else {
                        largest_jpeg = Some((start, len));
                    }
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }

    if let Some((start, len)) = largest_jpeg {
        return Ok(buffer[start..start + len].to_vec());
    }

    // Si on a trouvé un JPEG même plus petit (ex: 8 Ko)
    if let Some(pos) = buffer.windows(3).position(|w| w == [0xff, 0xd8, 0xff]) {
        let tail = &buffer[pos..];
        if let Some(end_rel) = tail.windows(2).position(|w| w == [0xff, 0xd9]) {
            return Ok(tail[..end_rel + 2].to_vec());
        }
    }

    Err("Aucune prévisualisation JPEG trouvée dans le fichier RAW".into())
}

/// Extraction spécifique pour Canon CR3 (boîte PRVW)
fn find_cr3_preview(file: &mut File) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    file.take(8 * 1024 * 1024).read_to_end(&mut buffer).map_err(|e| e.to_string())?;

    // Dans un CR3, la boîte 'PRVW' contient la preview JPEG.
    // L'en-tête de boîte fait 8 octets : 4 octets de taille + 4 octets de nom ('PRVW')
    if let Some(pos) = buffer.windows(4).position(|w| w == b"PRVW") {
        let content_start = pos + 4;
        // On cherche le marqueur FF D8 dans les 64 octets suivants
        if let Some(soi_rel) = buffer[content_start..content_start + 128.min(buffer.len() - content_start)]
            .windows(2)
            .position(|w| w == [0xff, 0xd8])
        {
            let jpeg_start = content_start + soi_rel;
            let tail = &buffer[jpeg_start..];
            if let Some(eoi_rel) = tail.windows(2).position(|w| w == [0xff, 0xd9]) {
                return Ok(tail[..eoi_rel + 2].to_vec());
            }
        }
    }
    Err("Prévisualisation CR3 introuvable".into())
}

///////


/// Décode un flux JPEG en RGB avec réduction DCT d'échelle proportionnelle à max_side.
fn decode_scaled_jpeg_reader<R: Read>(reader: R, max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    let mut decoder = Decoder::new(reader);
    decoder.read_info().map_err(|error| format!("JPEG illisible : {error}"))?;
    let side = (max_side * 3 / 2) as u16;
    decoder.scale(side, side).map_err(|error| format!("Réduction JPEG impossible : {error}"))?;
    let pixels = decoder.decode().map_err(|error| format!("Décodage JPEG impossible : {error}"))?;
    let info = decoder.info().ok_or("En-tête JPEG absent")?;
    let (width, height) = (info.width as usize, info.height as usize);
    let rgb = match info.pixel_format {
        PixelFormat::RGB24 => pixels,
        PixelFormat::L8 => pixels.iter().flat_map(|&value| [value, value, value]).collect(),
        PixelFormat::L16 | PixelFormat::CMYK32 => return Err("Format de pixels JPEG non pris en charge".into()),
    };
    if width == 0 || height == 0 || rgb.len() != width * height * 3 {
        return Err("Dimensions JPEG incohérentes".into());
    }
    Ok((rgb, width, height))
}

fn decode_scaled_rgb(source: &Path, max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    
    // Si c'est un format RAW, on extrait la prévisualisation JPEG intégrée
    let is_raw = matches!(ext.as_str(), "arw" | "cr2" | "cr3" | "nef" | "nrw" | "dng" | "raf" | "orf" | "rw2" | "raw");
    if is_raw {
        let jpeg_bytes = extract_raw_preview(source)?;
        return decode_scaled_jpeg_reader(Cursor::new(jpeg_bytes), max_side);
    }

    // HEIC / HEIF : décodage complet en Rust pur (crate heic-rs), pas de réduction DCT possible comme pour le JPEG
    if crate::heif::is_heif_path(source) {
        let decoded = crate::heif::decode(source)?;
        return Ok((decoded.rgb, decoded.width, decoded.height));
    }

    // Sinon décodage JPEG standard direct depuis le fichier
    let file = File::open(source).map_err(|error| error.to_string())?;
    decode_scaled_jpeg_reader(BufReader::with_capacity(256 * 1024, file), max_side)
}

/// Orientation EXIF (1 à 8), 1 si absente ou illisible.
pub(crate) fn read_orientation(source: &Path) -> u32 {
    let Ok(file) = File::open(source) else { return 1; };
    let mut reader = BufReader::new(file);
    Reader::new()
        .read_from_container(&mut reader)
        .ok()
        .and_then(|exif| exif.get_field(Tag::Orientation, In::PRIMARY).and_then(|field| field.value.get_uint(0)))
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1)
}

fn resize_to_fit(rgb: Vec<u8>, width: usize, height: usize, max_side: usize) -> (Vec<u8>, usize, usize) {
    let longest = width.max(height);
    if longest <= max_side { return (rgb, width, height); }
    let scale = max_side as f64 / longest as f64;
    let new_width = ((width as f64 * scale).round() as usize).max(1);
    let new_height = ((height as f64 * scale).round() as usize).max(1);
    (resize_area(&rgb, width, height, new_width, new_height), new_width, new_height)
}

/// Pour chaque pixel de destination : premier pixel source concerné et poids normalisés (recouvrement exact).
fn axis_weights(source_len: usize, destination_len: usize) -> Vec<(usize, Vec<f32>)> {
    let ratio = source_len as f64 / destination_len as f64;
    (0..destination_len).map(|index| {
        let start = index as f64 * ratio;
        let end = ((index + 1) as f64 * ratio).min(source_len as f64);
        let first = (start.floor() as usize).min(source_len - 1);
        let last = (end.ceil() as usize).clamp(first + 1, source_len);
        let mut weights: Vec<f32> = (first..last)
            .map(|position| (end.min((position + 1) as f64) - start.max(position as f64)).max(0.0) as f32)
            .collect();
        let total: f32 = weights.iter().sum();
        if total > 0.0 { for weight in &mut weights { *weight /= total; } } else { weights = vec![1.0]; }
        (first, weights)
    }).collect()
}

/// Réduction par moyenne des aires (séparable : horizontal puis vertical).
pub(crate) fn resize_area(source: &[u8], source_width: usize, source_height: usize, width: usize, height: usize) -> Vec<u8> {
    let horizontal = axis_weights(source_width, width);
    let vertical = axis_weights(source_height, height);
    let mut intermediate = vec![0f32; width * source_height * 3];
    for y in 0..source_height {
        let row = &source[y * source_width * 3..(y + 1) * source_width * 3];
        for (x, (first, weights)) in horizontal.iter().enumerate() {
            let mut sums = [0f32; 3];
            for (offset, weight) in weights.iter().enumerate() {
                let pixel = (first + offset) * 3;
                sums[0] += row[pixel] as f32 * weight;
                sums[1] += row[pixel + 1] as f32 * weight;
                sums[2] += row[pixel + 2] as f32 * weight;
            }
            let target = (y * width + x) * 3;
            intermediate[target..target + 3].copy_from_slice(&sums);
        }
    }
    let mut output = vec![0u8; width * height * 3];
    for (y, (first, weights)) in vertical.iter().enumerate() {
        for x in 0..width {
            let mut sums = [0f32; 3];
            for (offset, weight) in weights.iter().enumerate() {
                let pixel = ((first + offset) * width + x) * 3;
                sums[0] += intermediate[pixel] * weight;
                sums[1] += intermediate[pixel + 1] * weight;
                sums[2] += intermediate[pixel + 2] * weight;
            }
            let target = (y * width + x) * 3;
            for channel in 0..3 { output[target + channel] = sums[channel].round().clamp(0.0, 255.0) as u8; }
        }
    }
    output
}

/// Applique l'orientation EXIF (2 = miroir horizontal, 3 = 180°, 4 = miroir vertical, 5 = transposition,
/// 6 = 90° horaire, 7 = transversale, 8 = 90° antihoraire) ; 5 à 8 échangent largeur et hauteur.
pub(crate) fn apply_orientation(rgb: Vec<u8>, width: usize, height: usize, orientation: u32) -> (Vec<u8>, usize, usize) {
    if orientation <= 1 || orientation > 8 { return (rgb, width, height); }
    let (out_width, out_height) = if orientation >= 5 { (height, width) } else { (width, height) };
    let mut output = vec![0u8; rgb.len()];
    for y in 0..out_height {
        for x in 0..out_width {
            let (source_x, source_y) = match orientation {
                2 => (width - 1 - x, y),
                3 => (width - 1 - x, height - 1 - y),
                4 => (x, height - 1 - y),
                5 => (y, x),
                6 => (y, height - 1 - x),
                7 => (width - 1 - y, height - 1 - x),
                _ => (width - 1 - y, x),
            };
            let from = (source_y * width + source_x) * 3;
            let to = (y * out_width + x) * 3;
            output[to..to + 3].copy_from_slice(&rgb[from..from + 3]);
        }
    }
    (output, out_width, out_height)
}

fn write_jpeg(destination: &Path, rgb: &[u8], width: usize, height: usize) -> Result<(), String> {
    let parent = destination.parent().ok_or("Dossier de cache invalide")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("thumb-{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let encoded = Encoder::new_file(&temp, THUMBNAIL_JPEG_QUALITY)
        .map_err(|error| error.to_string())
        .and_then(|encoder| encoder.encode(rgb, width as u16, height as u16, ColorType::Rgb).map_err(|error| error.to_string()));
    if let Err(error) = encoded {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::remove_file(&temp);
        if !destination.is_file() { return Err(error.to_string()); }
    }
    Ok(())
}
