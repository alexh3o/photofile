//! Support HEIC / HEIF (conteneur ISO BMFF : photos d'iPhone, d'Android récents, `.hif` de Canon…).
//!
//! - Décodage des pixels : crate `heic-rs` (Rust pur, sans bibliothèque native à distribuer). Elle applique déjà les rotations
//!   et miroirs du conteneur (`irot` / `imir`) : l'orientation EXIF des HEIC ne doit donc PAS être réappliquée.
//! - Lecture : dimensions, paquet XMP intégré au fichier, profil ICC, EXIF (l'EXIF est lu par `kamadak-exif` dans exif.rs).
//! - Écriture : `xmp:Rating` / `xmp:Label` dans le paquet XMP du fichier (créé s'il n'existe pas), sans toucher aux pixels
//!   ni à l'EXIF. Le fichier n'est remplacé qu'après une vérification complète du résultat (voir `verify`) ; si la structure
//!   du fichier sort de ce que l'on sait modifier sans risque, `Outcome::Unsupported` est renvoyé et l'appelant utilise un sidecar.

use std::fs;
use std::io::Write;
use std::path::Path;

pub const EXTENSIONS: [&str; 3] = ["heic", "heif", "hif"];
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Espace réservé à la fin d'un paquet XMP agrandi : les modifications suivantes (note, couleur) tiennent alors sur place.
const XMP_PADDING: usize = 2048;
const XMP_TYPES: [&str; 2] = ["application/rdf+xml", "application/xmp+xml"];
const XMP_CONTENT_TYPE: &[u8] = b"application/rdf+xml\0";

pub fn is_heif_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

fn read_all(path: &Path) -> Option<Vec<u8>> {
    if fs::metadata(path).ok()?.len() > MAX_FILE_BYTES { return None; }
    fs::read(path).ok()
}

// ---------------------------------------------------------------------------
// Lecture des pixels
// ---------------------------------------------------------------------------

pub struct Decoded {
    pub rgb: Vec<u8>,
    pub width: usize,
    pub height: usize,
    /// Profil de couleur intégré (les iPhone écrivent du Display P3).
    pub icc: Option<Vec<u8>>,
}

/// Décode la photo en RGB 8 bits, rotations du conteneur appliquées.
pub fn decode(path: &Path) -> Result<Decoded, String> {
    let bytes = read_all(path).ok_or("Fichier HEIF illisible ou trop volumineux")?;
    let image = heic_rs::decode(&bytes, &heic_rs::DecodeOptions::default()).map_err(|e| format!("Décodage HEIC impossible : {e}"))?;
    if image.layout != heic_rs::PixelLayout::Rgb8 { return Err("Disposition de pixels HEIC inattendue".into()); }
    let (width, height) = (image.width as usize, image.height as usize);
    if width == 0 || height == 0 || image.data.len() != width * height * 3 { return Err("Dimensions HEIC incohérentes".into()); }
    let icc = icc_profile(&bytes);
    Ok(Decoded { rgb: image.data, width, height, icc })
}

fn icc_profile(bytes: &[u8]) -> Option<Vec<u8>> {
    let ctx = heic_rs::context::Context::open(bytes).ok()?;
    let props = ctx.props(ctx.meta.primary).ok()?;
    ctx.icc(&props).map(|icc| icc.to_vec())
}

/// JPEG pleine résolution (qualité 90, profil ICC conservé) pour l'affichage : le webview ne sait pas lire le HEIC.
pub fn preview_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let decoded = decode(path)?;
    if decoded.width > u16::MAX as usize || decoded.height > u16::MAX as usize { return Err("Image trop grande pour le JPEG".into()); }
    let mut output = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut output, 90);
    if let Some(icc) = &decoded.icc { let _ = encoder.add_icc_profile(icc); }
    encoder.encode(&decoded.rgb, decoded.width as u16, decoded.height as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("Encodage JPEG impossible : {e}"))?;
    Ok(output)
}

/// Dimensions affichées (après rotation du conteneur).
pub fn read_dimensions(path: &Path) -> Option<(i32, i32)> {
    let bytes = read_all(path)?;
    let info = heic_rs::probe(&bytes).ok()?;
    Some((info.width as i32, info.height as i32)).filter(|&(w, h)| w > 0 && h > 0)
}

/// Bloc EXIF au format d'un segment JPEG APP1 (`Exif\0\0` + TIFF), pour recopie dans un JPEG.
pub fn exif_app1_payload(path: &Path) -> Option<Vec<u8>> {
    let bytes = read_all(path)?;
    let ctx = heic_rs::context::Context::open(&bytes).ok()?;
    let tiff = ctx.exif(ctx.meta.primary).ok()??;
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(tiff);
    Some(payload)
}

// ---------------------------------------------------------------------------
// Analyse du conteneur (positions des champs, nécessaires pour modifier le fichier sur place)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct BoxRef { kind: [u8; 4], start: usize, header: usize, end: usize, open: bool }
impl BoxRef { fn payload(&self) -> usize { self.start + self.header } }

fn be16(d: &[u8], p: usize) -> Option<u16> { Some(u16::from_be_bytes(d.get(p..p + 2)?.try_into().ok()?)) }
fn be32(d: &[u8], p: usize) -> Option<u32> { Some(u32::from_be_bytes(d.get(p..p + 4)?.try_into().ok()?)) }
fn be64(d: &[u8], p: usize) -> Option<u64> { Some(u64::from_be_bytes(d.get(p..p + 8)?.try_into().ok()?)) }
fn uint(d: &[u8], p: usize, size: usize) -> Option<u64> {
    match size { 0 => Some(0), 1 => d.get(p).map(|v| *v as u64), 2 => be16(d, p).map(u64::from), 4 => be32(d, p).map(u64::from), 8 => be64(d, p), _ => None }
}
fn put_uint(d: &mut [u8], p: usize, size: usize, value: u64) -> bool {
    let bytes = value.to_be_bytes();
    if !matches!(size, 2 | 4 | 8) || (size < 8 && value >> (size * 8) != 0) { return false; }
    match d.get_mut(p..p + size) { Some(t) => { t.copy_from_slice(&bytes[8 - size..]); true } None => false }
}
fn cstr(d: &[u8], p: usize, limit: usize) -> Option<(String, usize)> {
    let end = p + d.get(p..limit)?.iter().position(|b| *b == 0)?;
    Some((String::from_utf8_lossy(&d[p..end]).into_owned(), end + 1))
}

fn children(d: &[u8], from: usize, to: usize) -> Option<Vec<BoxRef>> {
    let mut list = Vec::new();
    let mut p = from;
    while p + 8 <= to {
        let size = be32(d, p)? as u64;
        let kind: [u8; 4] = d.get(p + 4..p + 8)?.try_into().ok()?;
        let (header, end, open) = match size {
            0 => (8, to as u64, true),
            1 => (16, p as u64 + be64(d, p + 8)?, true),
            s => (8, p as u64 + s, false),
        };
        let end = usize::try_from(end).ok()?;
        if end > to || end < p + header { return None; }
        list.push(BoxRef { kind, start: p, header, end, open });
        p = end;
    }
    Some(list)
}

struct Extent { off_pos: usize, off: u64, len_pos: usize, len: u64 }
struct Loc { id: u32, cm: u8, base: u64, extents: Vec<Extent> }
struct Infe { id: u32, kind: [u8; 4], content_type: String }
struct Layout {
    meta: BoxRef, iinf: BoxRef, iinf_count_pos: usize, iinf_count_size: usize,
    iloc: BoxRef, iloc_ver: u8, off_size: usize, len_size: usize, base_size: usize, idx_size: usize,
    iloc_count_pos: usize, iloc_count_size: usize,
    iref: Option<(BoxRef, u8)>, idat: Option<BoxRef>, primary: u32,
    infe: Vec<Infe>, locs: Vec<Loc>, last_is_open: bool,
}

fn parse(d: &[u8]) -> Option<Layout> {
    let tops = children(d, 0, d.len())?;
    if tops.iter().any(|b| &b.kind == b"moov") { return None; } // séquences : offsets absolus ailleurs, non gérés
    let last_is_open = tops.last().map_or(true, |b| b.open);
    let meta = *tops.iter().find(|b| &b.kind == b"meta")?;
    let kids = children(d, meta.payload() + 4, meta.end)?;
    let find = |k: &[u8; 4]| kids.iter().find(|b| &b.kind == k).copied();

    let pitm = find(b"pitm")?;
    let primary = if *d.get(pitm.payload())? == 0 { be16(d, pitm.payload() + 4)? as u32 } else { be32(d, pitm.payload() + 4)? };

    let iinf = find(b"iinf")?;
    let iinf_count_size = if *d.get(iinf.payload())? == 0 { 2 } else { 4 };
    let iinf_count_pos = iinf.payload() + 4;
    let mut infe = Vec::new();
    for b in children(d, iinf_count_pos + iinf_count_size, iinf.end)? {
        if &b.kind != b"infe" { continue; }
        let ver = *d.get(b.payload())?;
        let mut p = b.payload() + 4;
        if ver >= 2 {
            let id = if ver >= 3 { let v = be32(d, p)?; p += 4; v } else { let v = be16(d, p)? as u32; p += 2; v };
            p += 2;
            let kind: [u8; 4] = d.get(p..p + 4)?.try_into().ok()?;
            p += 4;
            let (_, next) = cstr(d, p, b.end)?;
            let content_type = if &kind == b"mime" { cstr(d, next, b.end)?.0 } else { String::new() };
            infe.push(Infe { id, kind, content_type });
        } else {
            let id = be16(d, p)? as u32;
            p += 4;
            let (_, next) = cstr(d, p, b.end)?;
            infe.push(Infe { id, kind: *b"    ", content_type: cstr(d, next, b.end)?.0 });
        }
    }

    let iloc = find(b"iloc")?;
    let iloc_ver = *d.get(iloc.payload())?;
    if iloc_ver > 2 { return None; }
    let mut p = iloc.payload() + 4;
    let sizes = *d.get(p)?;
    let (off_size, len_size) = ((sizes >> 4) as usize, (sizes & 15) as usize);
    let sizes2 = *d.get(p + 1)?;
    let base_size = (sizes2 >> 4) as usize;
    let idx_size = if iloc_ver >= 1 { (sizes2 & 15) as usize } else { 0 };
    p += 2;
    let iloc_count_size = if iloc_ver < 2 { 2 } else { 4 };
    let iloc_count_pos = p;
    let count = uint(d, p, iloc_count_size)?;
    p += iloc_count_size;
    let mut locs = Vec::new();
    for _ in 0..count {
        let id = if iloc_ver < 2 { let v = be16(d, p)? as u32; p += 2; v } else { let v = be32(d, p)?; p += 4; v };
        let cm = if iloc_ver >= 1 { let v = (be16(d, p)? & 0xf) as u8; p += 2; v } else { 0 };
        p += 2;
        let base = uint(d, p, base_size)?;
        p += base_size;
        let ext_count = be16(d, p)?;
        p += 2;
        let mut extents = Vec::new();
        for _ in 0..ext_count {
            p += idx_size;
            let off_pos = p;
            let off = uint(d, p, off_size)?;
            p += off_size;
            let len_pos = p;
            let len = uint(d, p, len_size)?;
            p += len_size;
            extents.push(Extent { off_pos, off, len_pos, len });
        }
        locs.push(Loc { id, cm, base, extents });
    }
    if p > iloc.end { return None; }

    let iref = find(b"iref").map(|b| (b, d.get(b.payload()).copied().unwrap_or(0)));
    Some(Layout { meta, iinf, iinf_count_pos, iinf_count_size, iloc, iloc_ver, off_size, len_size, base_size, idx_size,
        iloc_count_pos, iloc_count_size, iref, idat: find(b"idat"), primary, infe, locs, last_is_open })
}

fn read_item(d: &[u8], lay: &Layout, loc: &Loc) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    for e in &loc.extents {
        if e.len == 0 { return None; }
        let start = usize::try_from(loc.base.checked_add(e.off)?).ok()?;
        let start = match loc.cm { 0 => start, 1 => lay.idat?.payload().checked_add(start)?, _ => return None };
        out.extend_from_slice(d.get(start..start.checked_add(usize::try_from(e.len).ok()?)?)?);
    }
    Some(out)
}

fn xmp_item<'a>(lay: &'a Layout) -> Option<(&'a Infe, &'a Loc)> {
    let infe = lay.infe.iter().find(|i| &i.kind == b"mime" && XMP_TYPES.iter().any(|t| i.content_type.starts_with(t)))?;
    Some((infe, lay.locs.iter().find(|l| l.id == infe.id)?))
}

fn xmp_text(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    std::str::from_utf8(&bytes[..end]).ok().map(str::to_string)
}

/// Paquet XMP intégré au fichier, s'il y en a un.
pub fn read_xmp(path: &Path) -> Option<String> {
    let data = read_all(path)?;
    let lay = parse(&data)?;
    let (_, loc) = xmp_item(&lay)?;
    xmp_text(&read_item(&data, &lay, loc)?)
}

// ---------------------------------------------------------------------------
// Écriture du paquet XMP
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Written,
    /// Rien à écrire (aucun changement, ou rien à retirer d'un fichier sans XMP).
    Unchanged,
    /// Structure non modifiable sans risque, ou résultat non vérifié : le fichier n'a pas été touché.
    Unsupported(String),
}

/// Complète le paquet avec des espaces (avant `<?xpacket end`, qui doit rester en dernier) jusqu'à `total` octets.
fn pad_packet(xml: &str, total: usize) -> Vec<u8> {
    let mut bytes = xml.as_bytes().to_vec();
    if bytes.len() >= total { return bytes; }
    let spaces = vec![b' '; total - bytes.len()];
    match xml.rfind("<?xpacket end") {
        Some(at) => { bytes.splice(at..at, spaces); }
        None => bytes.extend(spaces),
    }
    bytes
}

fn add_u32(d: &mut [u8], p: usize, delta: usize) -> bool {
    match be32(d, p).and_then(|v| u32::try_from(delta).ok().and_then(|x| v.checked_add(x))) {
        Some(v) => { d[p..p + 4].copy_from_slice(&v.to_be_bytes()); true }
        None => false,
    }
}

/// Applique `update` (paquet actuel ou chaîne vide -> nouveau paquet, vide s'il n'y a rien à écrire) au XMP intégré au fichier.
pub fn update_xmp(path: &Path, update: &dyn Fn(&str) -> String) -> std::io::Result<Outcome> {
    let data = fs::read(path)?;
    let unsupported = |why: &str| Ok(Outcome::Unsupported(why.to_string()));
    let Some(lay) = parse(&data) else { return unsupported("structure HEIF non reconnue"); };
    if lay.meta.header != 8 { return unsupported("boîte meta en taille étendue"); }

    let (output, expected, existing_id) = match xmp_item(&lay) {
        Some((infe, loc)) => {
            let Some(old) = read_item(&data, &lay, loc).filter(|_| loc.extents.len() == 1) else { return unsupported("XMP en plusieurs morceaux"); };
            let Some(old_text) = xmp_text(&old) else { return unsupported("XMP non UTF-8"); };
            let new = update(&old_text);
            if new.is_empty() || new == old_text { return Ok(Outcome::Unchanged); }
            let ext = &loc.extents[0];
            let mut out = data.clone();
            if new.len() <= old.len() {
                let start = match loc.cm {
                    0 => (loc.base + ext.off) as usize,
                    _ => lay.idat.map_or(0, |b| b.payload()) + (loc.base + ext.off) as usize,
                };
                out[start..start + old.len()].copy_from_slice(&pad_packet(&new, old.len()));
            } else {
                if loc.cm != 0 || lay.last_is_open { return unsupported("XMP à agrandir hors mdat"); }
                let payload = pad_packet(&new, new.len() + XMP_PADDING);
                let Ok(box_size) = u32::try_from(payload.len() + 8) else { return unsupported("XMP trop grand"); };
                let position = (out.len() + 8) as u64;
                if position < loc.base || !put_uint(&mut out, ext.off_pos, lay.off_size, position - loc.base)
                    || !put_uint(&mut out, ext.len_pos, lay.len_size, payload.len() as u64) { return unsupported("champs iloc trop étroits"); }
                out.extend_from_slice(&box_size.to_be_bytes());
                out.extend_from_slice(b"mdat");
                out.extend_from_slice(&payload);
            }
            (out, new, Some(infe.id))
        }
        None => {
            let new = update("");
            if new.is_empty() { return Ok(Outcome::Unchanged); }
            match add_xmp_item(&data, &lay, &new) { Ok(out) => (out, new, None), Err(why) => return unsupported(&why) }
        }
    };

    if let Err(why) = verify(&data, &lay, &output, &expected, existing_id) { return Ok(Outcome::Unsupported(format!("vérification échouée : {why}"))); }

    let temp = format!("{}.photoboggan-tmp", path.display());
    let written = fs::File::create(&temp).and_then(|mut f| { f.write_all(&output)?; f.sync_all() });
    if let Err(error) = written.and_then(|_| fs::rename(&temp, path)) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(Outcome::Written)
}

/// Ajoute un item XMP à un fichier qui n'en a pas : infe (iinf), entrée iloc, référence cdsc (iref) et données dans un nouveau mdat final.
/// Les boîtes grossissent à l'intérieur de meta : les offsets absolus des données situées après sont décalés en conséquence.
fn add_xmp_item(data: &[u8], lay: &Layout, xmp: &str) -> Result<Vec<u8>, String> {
    if lay.last_is_open { return Err("dernière boîte sans taille".into()); }
    if [Some(lay.iinf), Some(lay.iloc), lay.iref.map(|r| r.0)].into_iter().flatten().any(|b| b.header != 8) { return Err("boîtes en taille étendue".into()); }
    if !matches!(lay.off_size, 4 | 8) || !matches!(lay.len_size, 4 | 8) || !matches!(lay.base_size, 0 | 4 | 8) { return Err("champs iloc non standard".into()); }
    if lay.locs.iter().any(|l| l.cm == 2) { return Err("construction iloc par item".into()); }
    let new_id = lay.infe.iter().map(|i| i.id).chain(lay.locs.iter().map(|l| l.id)).max().unwrap_or(0) + 1;
    let wide = new_id > 0xffff || lay.primary > 0xffff;
    if wide && (lay.iloc_ver < 2 || lay.iref.map_or(true, |r| r.1 == 0)) { return Err("identifiants d'item trop grands".into()); }

    // infe (version 2, ou 3 pour un identifiant > 65535)
    let infe_ver: u8 = if new_id > 0xffff { 3 } else { 2 };
    let mut infe = Vec::new();
    infe.extend_from_slice(&[0, 0, 0, 0]);
    infe.extend_from_slice(b"infe");
    infe.extend_from_slice(&[infe_ver, 0, 0, 0]);
    if infe_ver == 3 { infe.extend_from_slice(&new_id.to_be_bytes()); } else { infe.extend_from_slice(&(new_id as u16).to_be_bytes()); }
    infe.extend_from_slice(&[0, 0]);
    infe.extend_from_slice(b"mime\0");
    infe.extend_from_slice(XMP_CONTENT_TYPE);
    let n = infe.len() as u32;
    infe[..4].copy_from_slice(&n.to_be_bytes());

    // entrée iloc : un seul extent, construction 0 ; offset provisoire
    let mut entry = Vec::new();
    if lay.iloc_ver < 2 { entry.extend_from_slice(&(new_id as u16).to_be_bytes()); } else { entry.extend_from_slice(&new_id.to_be_bytes()); }
    if lay.iloc_ver >= 1 { entry.extend_from_slice(&[0, 0]); }
    entry.extend_from_slice(&[0, 0]);
    entry.extend(std::iter::repeat(0u8).take(lay.base_size));
    entry.extend_from_slice(&1u16.to_be_bytes());
    entry.extend(std::iter::repeat(0u8).take(lay.idx_size));
    let off_at = entry.len();
    entry.extend(std::iter::repeat(0u8).take(lay.off_size + lay.len_size));

    // référence cdsc : l'item XMP décrit l'image principale
    let ref_wide = lay.iref.map_or(wide, |r| r.1 != 0);
    let mut cdsc = Vec::new();
    cdsc.extend_from_slice(&[0, 0, 0, 0]);
    cdsc.extend_from_slice(b"cdsc");
    if ref_wide { cdsc.extend_from_slice(&new_id.to_be_bytes()); } else { cdsc.extend_from_slice(&(new_id as u16).to_be_bytes()); }
    cdsc.extend_from_slice(&1u16.to_be_bytes());
    if ref_wide { cdsc.extend_from_slice(&lay.primary.to_be_bytes()); } else { cdsc.extend_from_slice(&(lay.primary as u16).to_be_bytes()); }
    let n = cdsc.len() as u32;
    cdsc[..4].copy_from_slice(&n.to_be_bytes());

    let mut inserts: Vec<(usize, Vec<u8>)> = vec![(lay.iinf.end, infe.clone())];
    let mut after_iloc = entry.clone();
    match lay.iref {
        Some((r, _)) => inserts.push((r.end, cdsc.clone())),
        None => {
            // pas d'iref : on en crée un (version 0) juste après iloc
            let mut iref = Vec::new();
            iref.extend_from_slice(&((12 + cdsc.len()) as u32).to_be_bytes());
            iref.extend_from_slice(b"iref");
            iref.extend_from_slice(&[0, 0, 0, 0]);
            iref.extend_from_slice(&cdsc);
            after_iloc.extend_from_slice(&iref);
        }
    }
    inserts.push((lay.iloc.end, after_iloc));
    let total: usize = inserts.iter().map(|(_, b)| b.len()).sum();

    let mut out = data.to_vec();
    // tailles et compteurs (tout ce qui est inséré l'est à l'intérieur de meta)
    let ok = add_u32(&mut out, lay.iinf.start, infe.len())
        && add_u32(&mut out, lay.iloc.start, entry.len())
        && add_u32(&mut out, lay.meta.start, total)
        && lay.iref.map_or(true, |(r, _)| add_u32(&mut out, r.start, cdsc.len()));
    if !ok { return Err("taille de boîte dépassée".into()); }
    let iinf_count = uint(data, lay.iinf_count_pos, lay.iinf_count_size).ok_or("compteur iinf")? + 1;
    let iloc_count = uint(data, lay.iloc_count_pos, lay.iloc_count_size).ok_or("compteur iloc")? + 1;
    if !put_uint(&mut out, lay.iinf_count_pos, lay.iinf_count_size, iinf_count) || !put_uint(&mut out, lay.iloc_count_pos, lay.iloc_count_size, iloc_count) {
        return Err("compteur trop grand".into());
    }
    // décalage des offsets absolus des données qui suivent les insertions
    for loc in lay.locs.iter().filter(|l| l.cm == 0) {
        for e in &loc.extents {
            let absolute = (loc.base + e.off) as usize;
            if absolute >= lay.meta.start && absolute < lay.meta.end { return Err("données à l'intérieur de meta".into()); }
            let shift: usize = inserts.iter().filter(|(pos, _)| *pos <= absolute).map(|(_, b)| b.len()).sum();
            if shift > 0 && !put_uint(&mut out, e.off_pos, lay.off_size, e.off + shift as u64) { return Err("offset iloc trop grand".into()); }
        }
    }
    // données XMP : nouveau mdat à la fin du fichier
    let payload = pad_packet(xmp, xmp.len() + XMP_PADDING);
    let position = (data.len() + total + 8) as u64;
    let mut entry_final = entry;
    if !put_uint(&mut entry_final, off_at, lay.off_size, position) || !put_uint(&mut entry_final, off_at + lay.off_size, lay.len_size, payload.len() as u64) {
        return Err("offset XMP trop grand".into());
    }
    for (pos, bytes) in inserts.iter_mut() {
        if *pos == lay.iloc.end { bytes[..entry_final.len()].copy_from_slice(&entry_final); }
    }
    inserts.sort_by(|a, b| b.0.cmp(&a.0));
    for (pos, bytes) in &inserts { out.splice(*pos..*pos, bytes.iter().copied()); }
    let box_size = u32::try_from(payload.len() + 8).map_err(|_| "XMP trop grand".to_string())?;
    out.extend_from_slice(&box_size.to_be_bytes());
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Contrôle du résultat avant remplacement du fichier : le nouveau fichier doit s'analyser, contenir le XMP attendu,
/// laisser toutes les autres données (image, EXIF…) identiques octet pour octet, et rester lisible par le décodeur.
fn verify(old: &[u8], old_lay: &Layout, new: &[u8], expected: &str, replaced_id: Option<u32>) -> Result<(), String> {
    let lay = parse(new).ok_or("structure illisible")?;
    for loc in &old_lay.locs {
        if Some(loc.id) == replaced_id { continue; }
        let before = read_item(old, old_lay, loc);
        let new_loc = lay.locs.iter().find(|l| l.id == loc.id).ok_or("item perdu")?;
        if before.is_some() && before != read_item(new, &lay, new_loc) { return Err(format!("données de l'item {} altérées", loc.id)); }
    }
    let (_, loc) = xmp_item(&lay).ok_or("item XMP absent")?;
    let stored = xmp_text(&read_item(new, &lay, loc).ok_or("XMP illisible")?).ok_or("XMP non UTF-8")?;
    let squash = |s: &str| s.split_whitespace().collect::<String>();
    if squash(&stored) != squash(expected) { return Err("XMP relu différent".into()); }
    if lay.primary != old_lay.primary { return Err("image principale changée".into()); }
    if let Ok(before) = heic_rs::probe(old) {
        let after = heic_rs::probe(new).map_err(|e| format!("décodeur : {e}"))?;
        if (before.width, before.height, before.has_exif) != (after.width, after.height, after.has_exif) { return Err("propriétés de l'image changées".into()); }
        let ctx = heic_rs::context::Context::open(new).map_err(|e| format!("décodeur : {e}"))?;
        if ctx.xmp_item(ctx.meta.primary).is_none() { return Err("XMP non rattaché à l'image".into()); }
    }
    Ok(())
}
