//! Redimensionnement par lot des photos (commande `resize_photo`).
//!
//! Crates en Rust pur déjà utilisées par l'application : `jpeg-decoder` / `jpeg-encoder` (JPEG) et `png` (PNG, déjà présente
//! dans l'arbre de dépendances via Tauri). Aucune bibliothèque native à distribuer.
//!
//! Algorithme : moyenne par aires (`thumbnails::resize_area`), le filtre idéal pour une réduction : rapide (séparable, deux passes),
//! sans halo ni moiré. Les JPEG sont de plus décodés à échelle réduite (DCT 1/2, 1/4, 1/8) quand la cible est nettement plus petite
//! que l'original, ce qui évite de décoder une photo de 24 Mpx en pleine résolution. L'image n'est jamais agrandie.
//! Sources gérées : JPEG, PNG, RAW (aperçu JPEG intégré, comme pour les miniatures) et HEIC / HEIF (décodage heic-rs).

use std::borrow::Cow;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use jpeg_decoder::{Decoder, PixelFormat};
use jpeg_encoder::{ColorType, Encoder};
use serde::{Deserialize, Serialize};

use crate::thumbnails;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
/// Sérialise la résolution des conflits de noms et le renommage final : deux fichiers traités en parallèle ne peuvent pas viser le même nom.
static COMMIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResizeMode {
    /// `value` = taille maximale du plus grand côté, en pixels.
    MaxSide,
    /// `value` = pourcentage (1 à 100) de chaque dimension.
    Percent,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    Jpeg,
    Png,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum PngCompression {
    Fast,
    Balanced,
    Best,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// Ne rien écrire et signaler le conflit à l'interface.
    Ask,
    Replace,
    Increment,
    Skip,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeOptions {
    pub mode: ResizeMode,
    pub value: u32,
    pub format: OutputFormat,
    pub jpeg_quality: u8,
    pub png_compression: PngCompression,
    pub keep_metadata: bool,
    /// Dossier de destination ; absent ou vide = dossier de la photo source.
    pub destination: Option<String>,
    pub suffix: String,
    pub conflict: ConflictPolicy,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResizeOutcome {
    Done { output: String, width: u32, height: u32 },
    /// Le fichier de destination existe et la politique était « Ask » : rien n'a été écrit.
    Conflict { output: String },
    Skipped { output: String },
}

/// Image décodée : RGB 8 bits (+ canal alpha éventuel), dans l'orientation stockée dans le fichier.
struct Raster {
    rgb: Vec<u8>,
    alpha: Option<Vec<u8>>,
    width: usize,
    height: usize,
}

/// Ce qui est repris du JPEG source quand il est converti en JPEG.
#[derive(Default)]
struct SourceMetadata {
    exif: Option<Vec<u8>>,
    xmp: Option<Vec<u8>>,
    iptc: Option<Vec<u8>>,
    icc: Option<Vec<u8>>,
}

pub fn resize_photo(source: &Path, options: &ResizeOptions) -> Result<ResizeOutcome, String> {
    validate_options(options)?;
    if !source.is_file() { return Err(format!("Fichier introuvable : {}", source.display())); }
    let target = target_path(source, options)?;
    if is_same_file(&target, source) {
        return Err("Le fichier de destination est la photo d'origine : choisissez un autre dossier ou un suffixe".into());
    }

    // Conflit détecté avant tout calcul : « Passer » ou la question à l'utilisateur ne coûtent pas un encodage.
    match resolve_conflict(&target, options.conflict) {
        Resolution::Write(_) => {}
        Resolution::Ask => return Ok(ResizeOutcome::Conflict { output: path_text(&target) }),
        Resolution::Skip => return Ok(ResizeOutcome::Skipped { output: path_text(&target) }),
    }

    let (bytes, width, height) = render(source, options)?;

    let directory = target.parent().ok_or("Dossier de destination invalide")?;
    let temp = directory.join(format!(".photoboggan-resize-{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    fs::write(&temp, &bytes).map_err(|error| format!("Écriture impossible : {error}"))?;

    // Le nom est résolu une seconde fois sous verrou : un autre fichier du lot a pu créer la même cible entre-temps.
    let _guard = COMMIT_LOCK.lock().map_err(|_| "Verrou d'écriture indisponible".to_string())?;
    let final_path = match resolve_conflict(&target, options.conflict) {
        Resolution::Write(path) => path,
        Resolution::Ask => { let _ = fs::remove_file(&temp); return Ok(ResizeOutcome::Conflict { output: path_text(&target) }); }
        Resolution::Skip => { let _ = fs::remove_file(&temp); return Ok(ResizeOutcome::Skipped { output: path_text(&target) }); }
    };
    if final_path.is_dir() {
        let _ = fs::remove_file(&temp);
        return Err(format!("« {} » est un dossier", final_path.display()));
    }
    if let Err(error) = fs::rename(&temp, &final_path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Écriture impossible : {error}"));
    }
    Ok(ResizeOutcome::Done { output: path_text(&final_path), width: width as u32, height: height as u32 })
}

fn validate_options(options: &ResizeOptions) -> Result<(), String> {
    match options.mode {
        ResizeMode::MaxSide if !(1..=100_000).contains(&options.value) => return Err("Taille maximale invalide".into()),
        ResizeMode::Percent if !(1..=100).contains(&options.value) => return Err("Pourcentage invalide (1 à 100)".into()),
        _ => {}
    }
    if options.suffix.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) {
        return Err("Le suffixe contient un caractère interdit dans un nom de fichier".into());
    }
    Ok(())
}

fn path_text(path: &Path) -> String { path.to_string_lossy().into_owned() }

/// Chemin de sortie : dossier choisi (ou dossier source) + nom d'origine sans extension + suffixe + extension du format.
fn target_path(source: &Path, options: &ResizeOptions) -> Result<PathBuf, String> {
    let directory = match options.destination.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(destination) => {
            let directory = PathBuf::from(destination);
            if !directory.is_dir() { return Err(format!("Dossier de destination introuvable : {destination}")); }
            directory
        }
        None => source.parent().ok_or("Dossier source invalide")?.to_path_buf(),
    };
    let stem = source.file_stem().map(|value| value.to_string_lossy().into_owned()).ok_or("Nom de fichier invalide")?;
    let extension = match options.format { OutputFormat::Jpeg => "jpg", OutputFormat::Png => "png" };
    Ok(directory.join(format!("{stem}{}.{extension}", options.suffix)))
}

fn is_same_file(first: &Path, second: &Path) -> bool {
    match (fs::canonicalize(first), fs::canonicalize(second)) {
        (Ok(a), Ok(b)) => a == b,
        _ => first.to_string_lossy().to_lowercase() == second.to_string_lossy().to_lowercase(),
    }
}

enum Resolution {
    Write(PathBuf),
    Ask,
    Skip,
}

/// « photo_s.jpg » existe : « photo_s_1.jpg », « photo_s_2.jpg »… (premier nom libre).
fn incremented_name(target: &Path) -> PathBuf {
    let directory = target.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = target.file_stem().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = target.extension().map(|value| format!(".{}", value.to_string_lossy())).unwrap_or_default();
    let mut index = 1u32;
    loop {
        let candidate = directory.join(format!("{stem}_{index}{extension}"));
        if !candidate.exists() { return candidate; }
        index += 1;
    }
}

fn resolve_conflict(target: &Path, policy: ConflictPolicy) -> Resolution {
    if !target.exists() { return Resolution::Write(target.to_path_buf()); }
    match policy {
        ConflictPolicy::Ask => Resolution::Ask,
        ConflictPolicy::Skip => Resolution::Skip,
        ConflictPolicy::Replace => Resolution::Write(target.to_path_buf()),
        ConflictPolicy::Increment => Resolution::Write(incremented_name(target)),
    }
}

// ---------------------------------------------------------------------------
// Décodage, redimensionnement, encodage
// ---------------------------------------------------------------------------

fn is_raw_extension(extension: &str) -> bool {
    matches!(extension, "arw" | "cr2" | "cr3" | "nef" | "nrw" | "dng" | "raf" | "orf" | "rw2" | "raw")
}

/// Dimensions finales pour des dimensions sources données (jamais plus grandes que la source).
fn target_size(options: &ResizeOptions, width: usize, height: usize) -> (usize, usize) {
    let scale = match options.mode {
        ResizeMode::Percent => options.value.min(100) as f64 / 100.0,
        ResizeMode::MaxSide => {
            let longest = width.max(height) as f64;
            (options.value as f64 / longest).min(1.0)
        }
    };
    if scale >= 1.0 { return (width, height); }
    (((width as f64 * scale).round() as usize).max(1), ((height as f64 * scale).round() as usize).max(1))
}

/// Renvoie les octets du fichier de sortie et ses dimensions.
fn render(source: &Path, options: &ResizeOptions) -> Result<(Vec<u8>, usize, usize), String> {
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let data = fs::read(source).map_err(|error| format!("Lecture impossible : {error}"))?;

    let is_png = data.starts_with(&[0x89, b'P', b'N', b'G']);
    let is_jpeg = data.starts_with(&[0xff, 0xd8]);
    // `original` : dimensions du fichier source (un JPEG peut être décodé à échelle réduite, la cible se calcule sur l'original).
    // `orientation` : rotation à appliquer aux pixels ; `exif_orientation` : valeur à remettre à 1 dans l'EXIF recopié (différente pour le HEIC,
    // dont le décodeur a déjà appliqué la rotation du conteneur alors que l'EXIF garde l'orientation d'origine).
    let (raster, original, metadata, orientation, exif_orientation) = if is_png {
        let (raster, icc) = decode_png(&data)?;
        let original = (raster.width, raster.height);
        (raster, original, SourceMetadata { icc, ..SourceMetadata::default() }, 1, 1)
    } else if crate::heif::is_heif_path(source) {
        let decoded = crate::heif::decode(source)?;
        let original = (decoded.width, decoded.height);
        let xmp = crate::heif::read_xmp(source).map(|packet| [XMP_HEADER, packet.as_bytes()].concat());
        let metadata = SourceMetadata { exif: crate::heif::exif_app1_payload(source), xmp, iptc: None, icc: decoded.icc };
        (Raster { rgb: decoded.rgb, alpha: None, width: decoded.width, height: decoded.height }, original, metadata, 1, thumbnails::read_orientation(source))
    } else if is_jpeg || is_raw_extension(&extension) {
        let jpeg = if is_jpeg { Cow::Borrowed(data.as_slice()) } else { Cow::Owned(thumbnails::extract_raw_preview(source)?) };
        let (raster, original) = decode_jpeg(&jpeg, options)?;
        let orientation = thumbnails::read_orientation(source);
        (raster, original, read_jpeg_metadata(&jpeg), orientation, orientation)
    } else {
        return Err("Format source non pris en charge pour le redimensionnement (JPEG, PNG, RAW et HEIC / HEIF uniquement)".into());
    };

    // Réduction (dans l'orientation stockée), puis orientation EXIF appliquée aux pixels : la photo s'affiche correctement
    // même sans tag d'orientation dans le fichier de sortie.
    let (target_width, target_height) = target_size(options, original.0, original.1);
    let raster = resize_raster(raster, target_width, target_height);
    let raster = orient_raster(raster, orientation);
    let (width, height) = (raster.width, raster.height);

    let bytes = match options.format {
        OutputFormat::Jpeg => encode_jpeg(&raster, options, &metadata, exif_orientation)?,
        OutputFormat::Png => encode_png(&raster, options, metadata.icc.as_deref())?,
    };
    Ok((bytes, width, height))
}

fn decode_jpeg(bytes: &[u8], options: &ResizeOptions) -> Result<(Raster, (usize, usize)), String> {
    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.read_info().map_err(|error| format!("JPEG illisible : {error}"))?;
    let info = decoder.info().ok_or("En-tête JPEG absent")?;
    let (source_width, source_height) = (info.width as usize, info.height as usize);
    let (target_width, target_height) = target_size(options, source_width, source_height);
    if target_width < source_width {
        // Décodage à échelle réduite : au moins 1,5 fois la cible, la moyenne par aires fait le reste.
        let request = |value: usize| (value * 3 / 2).clamp(1, u16::MAX as usize) as u16;
        decoder.scale(request(target_width), request(target_height)).map_err(|error| format!("Réduction JPEG impossible : {error}"))?;
    }
    let pixels = decoder.decode().map_err(|error| format!("Décodage JPEG impossible : {error}"))?;
    let info = decoder.info().ok_or("En-tête JPEG absent")?;
    let (width, height) = (info.width as usize, info.height as usize);
    let rgb = match info.pixel_format {
        PixelFormat::RGB24 => pixels,
        PixelFormat::L8 => pixels.iter().flat_map(|&value| [value, value, value]).collect(),
        PixelFormat::L16 | PixelFormat::CMYK32 => return Err("JPEG CMYK ou 16 bits non pris en charge".into()),
    };
    if width == 0 || height == 0 || rgb.len() != width * height * 3 { return Err("Dimensions JPEG incohérentes".into()); }
    Ok((Raster { rgb, alpha: None, width, height }, (source_width, source_height)))
}

fn decode_png(bytes: &[u8]) -> Result<(Raster, Option<Vec<u8>>), String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    // EXPAND : palettes, niveaux de gris < 8 bits et tRNS deviennent du RGB(A) 8 bits ; STRIP_16 : 16 bits -> 8 bits.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| format!("PNG illisible : {error}"))?;
    let icc = reader.info().icc_profile.as_ref().map(|profile| profile.to_vec());
    let mut buffer = vec![0u8; reader.output_buffer_size().ok_or("PNG trop grand")?];
    let frame = reader.next_frame(&mut buffer).map_err(|error| format!("Décodage PNG impossible : {error}"))?;
    let (width, height) = (frame.width as usize, frame.height as usize);
    if frame.bit_depth != png::BitDepth::Eight { return Err("Profondeur de bits PNG non prise en charge".into()); }
    let data = &buffer[..frame.buffer_size()];
    let pixel_count = width * height;
    let raster = match frame.color_type {
        png::ColorType::Rgb => Raster { rgb: data.to_vec(), alpha: None, width, height },
        png::ColorType::Rgba => {
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            let mut alpha = Vec::with_capacity(pixel_count);
            for pixel in data.chunks_exact(4) { rgb.extend_from_slice(&pixel[..3]); alpha.push(pixel[3]); }
            Raster { rgb, alpha: Some(alpha), width, height }
        }
        png::ColorType::Grayscale => Raster { rgb: data.iter().flat_map(|&value| [value, value, value]).collect(), alpha: None, width, height },
        png::ColorType::GrayscaleAlpha => {
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            let mut alpha = Vec::with_capacity(pixel_count);
            for pixel in data.chunks_exact(2) { rgb.extend_from_slice(&[pixel[0], pixel[0], pixel[0]]); alpha.push(pixel[1]); }
            Raster { rgb, alpha: Some(alpha), width, height }
        }
        png::ColorType::Indexed => return Err("PNG indexé non pris en charge".into()),
    };
    if raster.rgb.len() != pixel_count * 3 { return Err("Dimensions PNG incohérentes".into()); }
    Ok((raster, icc))
}

fn resize_raster(raster: Raster, width: usize, height: usize) -> Raster {
    if raster.width == width && raster.height == height { return raster; }
    let Raster { mut rgb, alpha, width: source_width, height: source_height } = raster;
    let Some(alpha) = alpha else {
        return Raster { rgb: thumbnails::resize_area(&rgb, source_width, source_height, width, height), alpha: None, width, height };
    };
    // Avec transparence : moyenne sur des couleurs prémultipliées, sinon les pixels transparents (souvent noirs) assombrissent les bords.
    for (pixel, &a) in rgb.chunks_exact_mut(3).zip(&alpha) {
        for channel in pixel { *channel = ((*channel as u32 * a as u32 + 127) / 255) as u8; }
    }
    let mut rgb = thumbnails::resize_area(&rgb, source_width, source_height, width, height);
    let alpha_as_rgb: Vec<u8> = alpha.iter().flat_map(|&a| [a, a, a]).collect();
    let alpha: Vec<u8> = thumbnails::resize_area(&alpha_as_rgb, source_width, source_height, width, height).chunks_exact(3).map(|pixel| pixel[0]).collect();
    for (pixel, &a) in rgb.chunks_exact_mut(3).zip(&alpha) {
        if a == 0 || a == 255 { continue; }
        for channel in pixel { *channel = ((*channel as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8; }
    }
    Raster { rgb, alpha: Some(alpha), width, height }
}

fn orient_raster(raster: Raster, orientation: u32) -> Raster {
    if orientation <= 1 { return raster; }
    let Raster { rgb, alpha, width, height } = raster;
    let (rgb, new_width, new_height) = thumbnails::apply_orientation(rgb, width, height, orientation);
    let alpha = alpha.map(|alpha| {
        let as_rgb: Vec<u8> = alpha.iter().flat_map(|&a| [a, a, a]).collect();
        thumbnails::apply_orientation(as_rgb, width, height, orientation).0.chunks_exact(3).map(|pixel| pixel[0]).collect()
    });
    Raster { rgb, alpha, width: new_width, height: new_height }
}

fn encode_jpeg(raster: &Raster, options: &ResizeOptions, metadata: &SourceMetadata, orientation: u32) -> Result<Vec<u8>, String> {
    if raster.width > u16::MAX as usize || raster.height > u16::MAX as usize { return Err("Image trop grande pour le JPEG".into()); }
    // Le JPEG n'a pas de transparence : aplatie sur fond blanc.
    let flattened;
    let rgb: &[u8] = match &raster.alpha {
        Some(alpha) => {
            flattened = raster.rgb.chunks_exact(3).zip(alpha).flat_map(|(pixel, &a)| {
                pixel.iter().map(move |&c| ((c as u32 * a as u32 + 255 * (255 - a as u32) + 127) / 255) as u8)
            }).collect::<Vec<u8>>();
            &flattened
        }
        None => &raster.rgb,
    };
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output, options.jpeg_quality.clamp(1, 100));
    // Le profil de couleur est toujours conservé (sans lui, les couleurs changent à l'affichage) ; EXIF, XMP et IPTC seulement si demandé.
    if let Some(icc) = &metadata.icc { let _ = encoder.add_icc_profile(icc); }
    if options.keep_metadata {
        if let Some(exif) = &metadata.exif {
            let mut exif = exif.clone();
            patch_exif(&mut exif, raster.width as u32, raster.height as u32, orientation);
            let _ = encoder.add_app_segment(1, &exif);
        }
        if let Some(xmp) = &metadata.xmp {
            let _ = encoder.add_app_segment(1, &patch_xmp_orientation(xmp));
        }
        if let Some(iptc) = &metadata.iptc { let _ = encoder.add_app_segment(13, iptc); }
    }
    encoder.encode(rgb, raster.width as u16, raster.height as u16, ColorType::Rgb).map_err(|error| format!("Encodage JPEG impossible : {error}"))?;
    Ok(output)
}

fn encode_png(raster: &Raster, options: &ResizeOptions, icc: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut info = png::Info::with_size(raster.width as u32, raster.height as u32);
    info.color_type = if raster.alpha.is_some() { png::ColorType::Rgba } else { png::ColorType::Rgb };
    info.bit_depth = png::BitDepth::Eight;
    info.icc_profile = icc.map(Cow::Borrowed);
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::with_info(&mut output, info).map_err(|error| format!("Encodage PNG impossible : {error}"))?;
        encoder.set_compression(match options.png_compression {
            PngCompression::Fast => png::Compression::Fast,
            PngCompression::Balanced => png::Compression::Balanced,
            PngCompression::Best => png::Compression::High,
        });
        let mut writer = encoder.write_header().map_err(|error| format!("Encodage PNG impossible : {error}"))?;
        match &raster.alpha {
            Some(alpha) => {
                let mut interleaved = Vec::with_capacity(raster.rgb.len() / 3 * 4);
                for (pixel, &a) in raster.rgb.chunks_exact(3).zip(alpha) { interleaved.extend_from_slice(pixel); interleaved.push(a); }
                writer.write_image_data(&interleaved)
            }
            None => writer.write_image_data(&raster.rgb),
        }.map_err(|error| format!("Encodage PNG impossible : {error}"))?;
    }
    Ok(output)
}

// ---------------------------------------------------------------------------
// Métadonnées JPEG : lecture des segments APPn de la source et mise à jour pour l'image redimensionnée
// ---------------------------------------------------------------------------

const EXIF_HEADER: &[u8] = b"Exif\0\0";
const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const ICC_HEADER: &[u8] = b"ICC_PROFILE\0";
const PHOTOSHOP_HEADER: &[u8] = b"Photoshop 3.0\0";

/// Parcourt les segments de l'en-tête (jusqu'au début des données image) : EXIF, XMP, IPTC et profil ICC (reconstitué s'il est en plusieurs morceaux).
fn read_jpeg_metadata(data: &[u8]) -> SourceMetadata {
    let mut metadata = SourceMetadata::default();
    let mut icc_chunks: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut pos = 2;
    while pos + 4 <= data.len() {
        if data[pos] != 0xff { break; }
        while pos < data.len() && data[pos] == 0xff { pos += 1; }
        if pos >= data.len() { break; }
        let marker = data[pos];
        pos += 1;
        if marker == 0xda || marker == 0xd9 { break; }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
        if pos + 2 > data.len() { break; }
        let length = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
        if length < 2 || pos + length > data.len() { break; }
        let payload = &data[pos + 2..pos + length];
        match marker {
            0xe1 if payload.starts_with(EXIF_HEADER) && metadata.exif.is_none() => metadata.exif = Some(payload.to_vec()),
            0xe1 if payload.starts_with(XMP_HEADER) && metadata.xmp.is_none() => metadata.xmp = Some(payload.to_vec()),
            0xed if payload.starts_with(PHOTOSHOP_HEADER) && metadata.iptc.is_none() => metadata.iptc = Some(payload.to_vec()),
            0xe2 if payload.starts_with(ICC_HEADER) && payload.len() > ICC_HEADER.len() + 2 => {
                icc_chunks.push((payload[ICC_HEADER.len()], payload[ICC_HEADER.len() + 2..].to_vec()));
            }
            _ => {}
        }
        pos += length;
    }
    if !icc_chunks.is_empty() {
        icc_chunks.sort_by_key(|(sequence, _)| *sequence);
        metadata.icc = Some(icc_chunks.into_iter().flat_map(|(_, chunk)| chunk).collect());
    }
    metadata
}

fn read_u16(bytes: &[u8], at: usize, little: bool) -> Option<u16> {
    let pair = [*bytes.get(at)?, *bytes.get(at + 1)?];
    Some(if little { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) })
}

fn read_u32(bytes: &[u8], at: usize, little: bool) -> Option<u32> {
    let quad = [*bytes.get(at)?, *bytes.get(at + 1)?, *bytes.get(at + 2)?, *bytes.get(at + 3)?];
    Some(if little { u32::from_le_bytes(quad) } else { u32::from_be_bytes(quad) })
}

fn write_u16(bytes: &mut [u8], at: usize, value: u16, little: bool) {
    if let Some(target) = bytes.get_mut(at..at + 2) { target.copy_from_slice(&if little { value.to_le_bytes() } else { value.to_be_bytes() }); }
}

fn write_u32(bytes: &mut [u8], at: usize, value: u32, little: bool) {
    if let Some(target) = bytes.get_mut(at..at + 4) { target.copy_from_slice(&if little { value.to_le_bytes() } else { value.to_be_bytes() }); }
}

/// Adapte l'EXIF copié à l'image redimensionnée, en place (la structure et les autres tags ne bougent pas) :
/// Orientation remise à 1 si les pixels ont été pivotés, PixelXDimension / PixelYDimension mis à jour,
/// et lien vers la miniature intégrée (IFD1) coupé, car elle ne correspondrait plus à l'image.
fn patch_exif(segment: &mut [u8], width: u32, height: u32, original_orientation: u32) {
    let tiff = EXIF_HEADER.len();
    let little = match segment.get(tiff..tiff + 2) { Some(b"II") => true, Some(b"MM") => false, _ => return };
    if read_u16(segment, tiff + 2, little) != Some(42) { return; }
    let Some(ifd0) = read_u32(segment, tiff + 4, little) else { return };
    let ifd0 = tiff + ifd0 as usize;
    let Some(count) = read_u16(segment, ifd0, little) else { return };
    let mut exif_ifd = None;
    for index in 0..count as usize {
        let entry = ifd0 + 2 + index * 12;
        match read_u16(segment, entry, little) {
            Some(0x0112) if original_orientation > 1 => write_u16(segment, entry + 8, 1, little),
            Some(0x8769) => exif_ifd = read_u32(segment, entry + 8, little),
            _ => {}
        }
    }
    write_u32(segment, ifd0 + 2 + count as usize * 12, 0, little);
    let Some(exif_ifd) = exif_ifd else { return };
    let exif_ifd = tiff + exif_ifd as usize;
    let Some(count) = read_u16(segment, exif_ifd, little) else { return };
    for index in 0..count as usize {
        let entry = exif_ifd + 2 + index * 12;
        let value = match read_u16(segment, entry, little) { Some(0xa002) => width, Some(0xa003) => height, _ => continue };
        match read_u16(segment, entry + 2, little) {
            Some(3) => write_u16(segment, entry + 8, value.min(u16::MAX as u32) as u16, little),
            Some(4) => write_u32(segment, entry + 8, value, little),
            _ => {}
        }
    }
}

/// Un paquet XMP peut contenir tiff:Orientation : remis à 1 (les pixels sont déjà pivotés), sinon l'image serait pivotée deux fois.
fn patch_xmp_orientation(segment: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(segment) else { return segment.to_vec() };
    let mut updated = text.to_string();
    // Forme attribut : tiff:Orientation="6"
    if let Some(start) = updated.find("tiff:Orientation=") {
        let value_start = start + "tiff:Orientation=".len() + 1;
        if let Some(end) = updated[value_start..].find(['"', '\'']) { updated.replace_range(value_start..value_start + end, "1"); }
    }
    // Forme élément : <tiff:Orientation>6</tiff:Orientation>
    if let Some(start) = updated.find("<tiff:Orientation>") {
        let value_start = start + "<tiff:Orientation>".len();
        if let Some(end) = updated[value_start..].find('<') { updated.replace_range(value_start..value_start + end, "1"); }
    }
    updated.into_bytes()
}
