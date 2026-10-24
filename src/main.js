import './styles.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { LANGUAGES, getLanguage, setLanguage, applyTranslations, t, tp, labelWithColon, onLanguageChange } from './i18n.js';
import { initPhotoActions, showPhotoInfo, copyPhotosTo, copyPhotosToClipboard, resizePhotos, confirmAndDelete, revealInFileManager, confirmDialog } from './photo-actions.js';
import { listen as listenToBackend } from '@tauri-apps/api/event';

// AJOUT BARRE TITRE
window.addEventListener('DOMContentLoaded', () => {
  const appWindow = getCurrentWindow();
  console.log("Fenêtre Tauri initialisée pour la barre de titre");

  document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
    console.log("Clic sur Minimiser");
    appWindow.minimize().catch(err => console.error("Erreur minimize:", err));


  // Ajout pour deb/Linux: Déplacement de la fenêtre à la souris (indispensable sous Linux / WebKitGTK / Wayland)
  const titlebarDrag = document.querySelector('.titlebar-drag-region');
  titlebarDrag?.addEventListener('mousedown', event => {
    // Bouton gauche uniquement (button === 0) et clic simple (detail === 1)
    if (event.button === 0 && event.detail === 1) {
      appWindow.startDragging().catch(err => console.error("Erreur startDragging:", err));
    }
  });
  // Double-clic sur la barre pour maximiser / restaurer (comportement standard OS)
  titlebarDrag?.addEventListener('dblclick', async () => {
    try {
      const isMax = await appWindow.isMaximized();
      if (isMax) await appWindow.unmaximize();
      else await appWindow.maximize();
      await syncWindowState();
    } catch (err) {
      console.error("Erreur double-clic titre:", err);
    }
  });
    
  });

  document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
    console.log("Clic sur Maximiser");
    try {
      const isMax = await appWindow.isMaximized();
      if (isMax) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
      await syncWindowState();
    } catch (err) {
      console.error("Erreur maximize/unmaximize:", err);
    }
  });

  document.getElementById('titlebar-close')?.addEventListener('click', () => {
    console.log("Clic sur Fermer");
    appWindow.close().catch(err => console.error("Erreur close:", err));
  });

  // Icône du bouton Maximiser / Restaurer d'après l'état réel de la fenêtre (aussi modifié hors du bouton : double-clic sur la barre, raccourcis Windows).
  const maximizeButton = document.getElementById('titlebar-maximize');
  const MAXIMIZE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>';
  const RESTORE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor"/><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/></svg>';
  let windowMaximized = false;

  function renderMaximizeButton() {
    if (!maximizeButton) return;
    const label = t(windowMaximized ? 'Restore down' : 'Maximize');
    maximizeButton.innerHTML = windowMaximized ? RESTORE_ICON : MAXIMIZE_ICON;
    maximizeButton.title = label;
    maximizeButton.setAttribute('aria-label', label);
  }

  // Lit l'état de la fenêtre : icône Maximiser / Restaurer, et barre de titre masquée en mode immersif (plein écran de la fenêtre).
  async function syncWindowState() {
    try {
      const [maximized, fullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
      windowMaximized = maximized;
      renderMaximizeButton();
      document.body.classList.toggle('immersive', fullscreen);
    } catch (err) {
      console.error("Erreur lecture de l'état de la fenêtre:", err);
    }
  }

  let windowStateSyncScheduled = false;
  appWindow.onResized(() => {
    if (windowStateSyncScheduled) return;
    windowStateSyncScheduled = true;
    requestAnimationFrame(() => {
      windowStateSyncScheduled = false;
      syncWindowState();
    });
  }).catch(err => console.error("Erreur suivi du redimensionnement:", err));
  onLanguageChange(renderMaximizeButton);
  renderMaximizeButton();
  syncWindowState();

  // MODE IMMERSIF (F11) : fenêtre en plein écran, par-dessus la barre des tâches, sans barre de titre.
  // F11 y entre et en sort.
  // Ne pas confondre avec le plein écran d'une photo (touche F, double-clic).
  let immersiveToggleRunning = false;
  let maximizedBeforeImmersive = false;
  async function toggleImmersiveMode() {
    if (immersiveToggleRunning) return;
    immersiveToggleRunning = true;
    try {
      if (await appWindow.isFullscreen()) {
        await appWindow.setFullscreen(false);
        if (maximizedBeforeImmersive) await appWindow.maximize();
        maximizedBeforeImmersive = false;
      } else {
        // Fenêtre sans décoration maximisée : le plein écran ne redimensionne pas la zone web (elle garde la taille de la zone de travail, sans la barre des tâches).
        // On la restaure donc d'abord, puis on la maximise de nouveau en sortant du mode immersif.
        maximizedBeforeImmersive = await appWindow.isMaximized();
        if (maximizedBeforeImmersive) await appWindow.unmaximize();
        await appWindow.setFullscreen(true);
      }
      await syncWindowState();
    } catch (err) {
      console.error("Erreur mode immersif:", err);
    } finally {
      immersiveToggleRunning = false;
    }
  }

  // Ce raccourci reste actif même quand un champ de saisie a le focus (le gestionnaire de touches principal les ignore).
  window.addEventListener('keydown', event => {
    if (event.key !== 'F11') return;
    event.preventDefault();
    if (!event.repeat) toggleImmersiveMode();
  });
});

// ETAT
let photos = [];
let loadedPhotos = [];
let folders = [];
let folderTreePhotos = [];
let currentFolderFilter = null;
let includeSubfolders = localStorage.getItem('includeSubfolders') !== 'false';
let keywordFilters = [];
let filenameFilters = []; // chaînes à retrouver dans le nom de fichier (toutes doivent y figurer, casse ignorée)
let colorFilters = new Set(); // couleurs cochées dans le filtre (vide = pas de filtre)
let selectedIndices = new Set();
let lastSelectedIndex = 0;
let isFullscreen = false; // Etat d'affichage plein écran de photos
let fullscreenRatingPinned = false;
let fullscreenRatingTimeout = null;
const fullscreenImageCache = new Map();
// Version des fichiers modifiés hors de l'application (chemin -> horodatage) : ajoutée à l'URL pour ne pas réafficher une image périmée du cache.
const photoVersions = new Map();
function photoUrl(photo) {
  const version = photoVersions.get(photo.path);
  return convertFileSrc(photo.path) + (version ? `?v=${version}` : '');
}

// Ajout extracteur RAW
const RAW_EXTENSIONS = new Set(['arw', 'cr2', 'cr3', 'nef', 'nrw', 'dng', 'raf', 'orf', 'rw2', 'raw']);
function isRawPath(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

const rawPreviewPromises = new Map();
async function getPhotoDisplayUrl(photo) {
  if (!photo) return '';
  if (!isRawPath(photo.path)) {
    return photoUrl(photo);
  }
  let promise = rawPreviewPromises.get(photo.path);
  if (!promise) {
    promise = invoke('get_raw_preview_path', { sourcePath: photo.path })
      .then(cachedPath => convertFileSrc(cachedPath))
      .catch(err => {
        console.error('Extraction preview RAW impossible', photo.path, err);
        return photoUrl(photo);
      });
    rawPreviewPromises.set(photo.path, promise);
  }
  return promise;
}


// COULEURS (XMP Label) : clé stockée en base, label = clé de traduction du libellé affiché. La couleur visuelle est dans le CSS (.flag-<clé>).
const COLOR_FLAGS = [
  { key: 'red', label: 'Red' },
  { key: 'orange', label: 'Orange' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'green', label: 'Green' },
  { key: 'blue', label: 'Blue' },
  { key: 'magenta', label: 'Magenta' },
  { key: 'grey', label: 'Grey' },
  { key: 'black', label: 'Black' },
  { key: 'white', label: 'White' },
];
// Libellés traduits au moment de l'affichage (has/get comme une Map, pour ne pas changer les appels existants).
const colorFlagLabels = {
  has: key => COLOR_FLAGS.some(flag => flag.key === key),
  get: key => {
    const flag = COLOR_FLAGS.find(candidate => candidate.key === key);
    return flag ? t(flag.label) : undefined;
  },
};

// APPARENCE (thème et couleur de sélection, mémorisés localement)
const DEFAULT_SELECTION_COLOR = '#3498db';
let appTheme = localStorage.getItem('appTheme') === 'light' ? 'light' : 'dark';
const storedSelectionColor = localStorage.getItem('selectionColor') || '';
let selectionColor = /^#[0-9a-f]{6}$/i.test(storedSelectionColor) ? storedSelectionColor : DEFAULT_SELECTION_COLOR;
// Couleur des boutons activés (Filtres, Comparer, Aperçu, Info), distincte de la couleur de sélection des miniatures.
const DEFAULT_ACTIVE_BUTTON_COLOR = '#3498db';
const storedActiveButtonColor = localStorage.getItem('activeButtonColor') || '';
let activeButtonColor = /^#[0-9a-f]{6}$/i.test(storedActiveButtonColor) ? storedActiveButtonColor : DEFAULT_ACTIVE_BUTTON_COLOR;
// Texte noir sur les couleurs très claires (jaune…), blanc sinon, pour rester lisible sur le bouton activé.
function readableTextColor(hex) {
  const [r, g, b] = [1, 3, 5]
    .map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#111' : '#fff';
}
function applyAppearance() {
  document.documentElement.dataset.theme = appTheme;
  document.documentElement.style.setProperty('--selected-border', selectionColor);
  document.documentElement.style.setProperty('--active-button', activeButtonColor);
  document.documentElement.style.setProperty('--active-button-text', readableTextColor(activeButtonColor));
}
applyAppearance();

// ASSOMBRISSEMENT DES HORS-SÉLECTIONS AU SURVOL
let dimUnselected = localStorage.getItem('dimUnselectedOnHover') || '0.65';
function applyDimUnselected() {
  const active = dimUnselected !== 'none';
  document.body.classList.toggle('dim-unselected-active', active);
  if (active) {
    document.documentElement.style.setProperty('--dim-unselected-brightness', dimUnselected);
  }
  const select = document.getElementById('dim-unselected-select');
  if (select) select.value = dimUnselected;
}
applyDimUnselected();
document.getElementById('dim-unselected-select')?.addEventListener('change', event => {
  dimUnselected = event.target.value;
  localStorage.setItem('dimUnselectedOnHover', dimUnselected);
  applyDimUnselected();
});

// DOM
let thumbnailCacheSize = Number(localStorage.getItem('thumbnailCacheSize')) || 512;
if (![256, 512, 768, 1024].includes(thumbnailCacheSize)) thumbnailCacheSize = 512;
  let thumbnailSize = Number(localStorage.getItem('thumbnailSize')) || 160;
thumbnailSize = Math.max(96, Math.min(thumbnailCacheSize, 96 + Math.round((thumbnailSize - 96) / 16) * 16));
let columns = 1;
const storedThumbnailLayout = localStorage.getItem('thumbnailLayout');
let thumbnailLayout = ['square', 'justified', 'masonry'].includes(storedThumbnailLayout) ? storedThumbnailLayout : 'square';
// TRI DES MINIATURES (critère et ordre mémorisés localement). Par défaut : date de prise de vue, de la plus récente à la plus ancienne (ordre historique de la grille).
const SORT_KEYS = ['taken', 'modified', 'name'];
const storedSortKey = localStorage.getItem('photoSortKey');
let sortKey = SORT_KEYS.includes(storedSortKey) ? storedSortKey : 'taken';
let sortOrder = localStorage.getItem('photoSortOrder') === 'asc' ? 'asc' : 'desc';
// SÉPARATEURS DE LA GRILLE (mémorisés localement, un choix par famille de tri) : par défaut aucun. Dates (tri par date de prise de vue ou de modification) :
// par jour, semaine, mois ou année. Nom de fichier : par dossier (le tri par nom se fait alors au sein de chaque dossier).
const DATE_SEPARATORS = ['none', 'day', 'week', 'month', 'year'];
const NAME_SEPARATORS = ['none', 'folder'];
const storedDateSeparator = localStorage.getItem('photoDateSeparator');
let dateSeparator = DATE_SEPARATORS.includes(storedDateSeparator) ? storedDateSeparator : 'none';
const storedNameSeparator = localStorage.getItem('photoNameSeparator');
let nameSeparator = NAME_SEPARATORS.includes(storedNameSeparator) ? storedNameSeparator : 'none';
let photoLayouts = [];
let separatorLayouts = []; // { group, y, height, label, title } : lignes de séparation, dans l'ordre de la grille
const renderedSeparatorNodes = new Map();
let layoutContentHeight = 0;
let maximumPhotoHeight = thumbnailSize;
const gridContainer = document.getElementById('grid-view');
const scrollContent = document.getElementById('virtual-scroll-content');
const previewStage = document.getElementById('preview-stage');
const fullscreenView = document.getElementById('fullscreen-view');
const fullscreenImg = document.getElementById('fullscreen-image');
// Zoom du plein écran : même structure qu'une case de l'aperçu (voir layoutPreviewSlot), la vue entière occupe toute la fenêtre (marge 1).
const fullscreenSlot = { photo: null, url: '', cell: fullscreenView, img: fullscreenImg, naturalWidth: 0, naturalHeight: 0, fit: 1, fitMargin: 1, zoom: null, tx: 0, ty: 0, displayWidth: 0, displayHeight: 0, center: { x: 0.5, y: 0.5 } };
let fullscreenLoadToken = 0;
let fullscreenDrag = null;
const sidebarPanel = document.getElementById('sidebar-panel');
const folderTree = document.getElementById('folder-tree');
const settingsModal = document.getElementById('settings-modal');
const settingsFolderList = document.getElementById('settings-folder-list');
const renderedThumbnailNodes = new Map();
const thumbnailCacheLookups = new Map();
const thumbnailCacheWrites = new Map();
let scrollRenderPending = false;

let justifiedLayoutTimer = null;

// Marge latérale de la grille : au survol, une miniature grossit de 3 % (voir .thumbnail:hover) et dépasserait de la zone, ce qui ferait
// apparaître une barre de défilement horizontale. 8 px couvrent l'agrandissement d'une miniature de 512 px (la taille maximale).
const GRID_SIDE_MARGIN = 8;
scrollContent.style.left = `${GRID_SIDE_MARGIN}px`;
scrollContent.style.width = `calc(100% - ${2 * GRID_SIDE_MARGIN}px)`;

function scheduleJustifiedRelayout() {
  clearTimeout(justifiedLayoutTimer);
  justifiedLayoutTimer = setTimeout(() => {
    if (thumbnailLayout === 'justified') updateVirtualScroller();
  }, 80);
}

// Marge de pré-rendu (en hauteurs de fenêtre de grille) de part et d'autre de la zone visible :
// les miniatures en cache sont déjà chargées quand elles arrivent à l'écran.
const THUMBNAIL_OVERSCAN_SCREENS = 1;

// Recherche dans le cache par lots : toutes les demandes d'un même rendu partent dans le même appel IPC.
const THUMBNAIL_LOOKUP_BATCH_SIZE = 128;
const pendingThumbnailLookups = new Map();
let thumbnailLookupFlushScheduled = false;

function lookupCachedThumbnail(sourcePath) {
  let lookup = thumbnailCacheLookups.get(sourcePath);
  if (lookup) return lookup;
  lookup = new Promise(resolve => pendingThumbnailLookups.set(sourcePath, resolve));
  thumbnailCacheLookups.set(sourcePath, lookup);
  if (!thumbnailLookupFlushScheduled) {
    thumbnailLookupFlushScheduled = true;
    setTimeout(flushThumbnailLookups, 0);
  }
  return lookup;
}

function flushThumbnailLookups() {
  thumbnailLookupFlushScheduled = false;
  const pending = [...pendingThumbnailLookups];
  pendingThumbnailLookups.clear();
  for (let start = 0; start < pending.length; start += THUMBNAIL_LOOKUP_BATCH_SIZE) {
    const batch = pending.slice(start, start + THUMBNAIL_LOOKUP_BATCH_SIZE);
    invoke('get_cached_thumbnail_paths', { sourcePaths: batch.map(([sourcePath]) => sourcePath) })
      .catch(() => [])
      .then(paths => batch.forEach(([, resolve], index) => resolve(paths[index] ?? null)));
  }
}

// Génération des miniatures absentes du cache (côté Rust, avec repli webview) : le nombre de tâches simultanées
// est limité pour laisser des cœurs à l'interface. Les tâches dont la miniature
// a quitté le DOM (défilement rapide) sont abandonnées tant qu'elles n'ont pas démarré, et la plus proche
// de la zone visible passe en premier.
const MAX_THUMBNAIL_GENERATIONS = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
let thumbnailGenerationQueue = [];
let activeThumbnailGenerations = 0;
let thumbnailPumpScheduled = false;

function takeNextThumbnailGeneration() {
  thumbnailGenerationQueue = thumbnailGenerationQueue.filter(job => job.image.isConnected && job.image.dataset.sourcePath === job.sourcePath);
  const viewTop = gridContainer.scrollTop;
  const viewBottom = viewTop + gridContainer.clientHeight;
  let best = -1;
  let bestDistance = Infinity;
  let bestTop = Infinity;
  thumbnailGenerationQueue.forEach((job, position) => {
    const node = job.image.closest('.thumbnail');
    const top = node?._y ?? 0;
    const bottom = top + (node?._height ?? 0);
    const distance = bottom < viewTop ? viewTop - bottom : top > viewBottom ? top - viewBottom : 0;
    if (distance < bestDistance || (distance === bestDistance && top < bestTop)) {
      best = position;
      bestDistance = distance;
      bestTop = top;
    }
  });
  return best < 0 ? null : thumbnailGenerationQueue.splice(best, 1)[0];
}

function pumpThumbnailGenerationQueue() {
  thumbnailPumpScheduled = false;
  while (activeThumbnailGenerations < MAX_THUMBNAIL_GENERATIONS) {
    const job = takeNextThumbnailGeneration();
    if (!job) return;
    activeThumbnailGenerations++;
    job.run().catch(() => {}).finally(() => {
      activeThumbnailGenerations--;
      pumpThumbnailGenerationQueue();
    });
  }
}

function enqueueThumbnailGeneration(image, sourcePath, run) {
  thumbnailGenerationQueue.push({ image, sourcePath, run });
  // Le démarrage est différé d'un tour de boucle pour choisir parmi toutes les demandes d'un même rendu.
  if (!thumbnailPumpScheduled) {
    thumbnailPumpScheduled = true;
    setTimeout(pumpThumbnailGenerationQueue, 0);
  }
}

// Apprend le ratio réel de la miniature (dimensions EXIF absentes ou fausses en base) et relance la disposition justifiée.
function learnPhotoAspectRatio(photo, ratio) {
  if (!(ratio > 0)) return;
  const previousRatio = photo.aspectRatio || (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 0);
  // Tolérance relative de 0,2 % : l'arrondi des dimensions d'une miniature (ex. 512x341) ne doit pas relancer la disposition.
  if (Math.abs(previousRatio - ratio) > ratio * 0.002) {
    photo.aspectRatio = ratio;
    scheduleJustifiedRelayout();
  }
}

function updatePhotoAspectRatio(image, photo) {
  if (image.naturalWidth > 0 && image.naturalHeight > 0) learnPhotoAspectRatio(photo, image.naturalWidth / image.naturalHeight);
}

// Affiche une miniature du cache dans l'image et apprend son ratio réel au chargement.
function showCachedThumbnail(image, cachedPath, photo) {
  image.onload = () => {
    if (!image.isConnected) return;
    image.classList.add('loaded');
    updatePhotoAspectRatio(image, photo);
  };
  image.src = convertFileSrc(cachedPath);
}

// Repli (PNG, JPEG CMYK, fichier que le backend ne sait pas lire) : ancienne génération dans le webview,
// limitée à peu de tâches car elle décode l'original en pleine résolution.
const MAX_WEBVIEW_THUMBNAIL_FALLBACKS = 2;
let activeWebviewThumbnailFallbacks = 0;
const webviewThumbnailFallbackWaiters = [];

async function generateThumbnailInWebview(image, sourcePath, photo) {
  while (activeWebviewThumbnailFallbacks >= MAX_WEBVIEW_THUMBNAIL_FALLBACKS) {
    await new Promise(resolve => webviewThumbnailFallbackWaiters.push(resolve));
  }
  activeWebviewThumbnailFallbacks++;
  try {
    const loaded = new Promise(resolve => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
    });
    image.src = photoUrl(photo);
    const success = await loaded;
    image.onload = null;
    image.onerror = null;
    if (!success) return;
    image.classList.add('loaded');
    updatePhotoAspectRatio(image, photo);
    await cacheThumbnail(image, sourcePath);
  } finally {
    activeWebviewThumbnailFallbacks--;
    webviewThumbnailFallbackWaiters.shift()?.();
  }
}

function loadThumbnail(image, sourcePath, photo) {
  image.dataset.sourcePath = sourcePath;
  lookupCachedThumbnail(sourcePath).then(cachedPath => {
    if (!image.isConnected) return;
    if (cachedPath) {
      showCachedThumbnail(image, cachedPath, photo);
      return;
    }
    // Pas de miniature en cache : génération côté Rust quand une place se libère dans la file de génération.
    enqueueThumbnailGeneration(image, sourcePath, async () => {
      let generated = null;
      try {
        generated = await invoke('generate_thumbnail', { sourcePath, maxSide: thumbnailCacheSize });
      } catch {
        // Format non géré par le backend : repli ci-dessous.
      }
      if (!generated) {
        // Fichier supprimé hors de l'application ? On le retire du catalogue au lieu de laisser une miniature noire.
        if (await checkPhotoMissing(sourcePath)) return;
        await generateThumbnailInWebview(image, sourcePath, photo);
        return;
      }
      thumbnailCacheLookups.set(sourcePath, Promise.resolve(generated.path));
      if (generated.width > 0 && generated.height > 0) learnPhotoAspectRatio(photo, generated.width / generated.height);
      if (image.isConnected && image.dataset.sourcePath === sourcePath) showCachedThumbnail(image, generated.path, photo);
    });
  });
}

function cacheThumbnail(image, sourcePath) {
  if (thumbnailCacheWrites.has(sourcePath)) return thumbnailCacheWrites.get(sourcePath);
  const task = (async () => {
    let bitmap;
    try {
      await image.decode();
      bitmap = await createImageBitmap(image);
      const scale = Math.min(1, thumbnailCacheSize / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
      if (!blob) return;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const cachedPath = await invoke('save_thumbnail_cache', { sourcePath, dataUrl });
      thumbnailCacheLookups.set(sourcePath, Promise.resolve(cachedPath));
      if (image.isConnected && image.dataset.sourcePath === sourcePath) {
        image.onload = null;
        image.src = convertFileSrc(cachedPath);
      }
    } catch (error) {
      console.debug('Mise en cache de miniature impossible', sourcePath, error);
    } finally {
      bitmap?.close();
      thumbnailCacheWrites.delete(sourcePath);
    }
  })();
  thumbnailCacheWrites.set(sourcePath, task);
  return task;
}

// ==========================================
// SYNCHRONISATION « PARESSEUSE » AVEC LE DISQUE
// ==========================================
// Une photo supprimée hors de l'application reste dans le catalogue tant qu'on ne s'en aperçoit pas. Plutôt que de parcourir
// le disque, on vérifie au moment où l'affichage échoue (miniature impossible à générer, image qui ne se charge pas) :
// aucun coût tant que les fichiers sont là. Les demandes sont groupées en un seul appel ; le backend ne retire que les fichiers
// réellement introuvables dont le dossier suivi est accessible, puis la grille est mise à jour en conservant la sélection.
const MISSING_CHECK_DELAY_MS = 25;
let pendingMissingChecks = new Map(); // chemin -> fonctions à appeler avec le résultat
let missingCheckTimer = null;

// Résout à true si la photo était bien introuvable sur le disque (elle a alors été retirée du catalogue et de la grille).
function checkPhotoMissing(sourcePath) {
  return new Promise(resolve => {
    const waiters = pendingMissingChecks.get(sourcePath);
    if (waiters) waiters.push(resolve);
    else pendingMissingChecks.set(sourcePath, [resolve]);
    if (missingCheckTimer === null) missingCheckTimer = setTimeout(flushMissingChecks, MISSING_CHECK_DELAY_MS);
  });
}

async function flushMissingChecks() {
  missingCheckTimer = null;
  const batch = [...pendingMissingChecks];
  pendingMissingChecks = new Map();
  let removed = [];
  try {
    removed = await invoke('remove_missing_photos', { paths: batch.map(([path]) => path) });
  } catch (error) {
    console.debug('Vérification des fichiers manquants impossible', error);
  }
  const removedPaths = new Set(removed);
  if (removedPaths.size) removePhotosFromLibrary(removed, { keepSelection: true });
  for (const [path, waiters] of batch) for (const resolve of waiters) resolve(removedPaths.has(path));
}

// ==========================================
// CHARGEMENT PHOTOS & DOSSIERS
// ==========================================
async function loadFolders() {
  folders = await invoke('get_folders');
  renderFolderTree();
  renderSettingsFolderList();
}

async function loadPhotos() {
  loadedPhotos = await invoke('get_photos_paginated', { 
    offset: 0, 
    limit: 50000, 
    folderFilter: currentFolderFilter,
    recursive: includeSubfolders,
  });
  if (currentFolderFilter === null) folderTreePhotos = loadedPhotos;
  renderFolderTree();
  renderKeywordFilters();
  applyPhotoFilters();
}

function hasActiveFilters() {
  const ratingThreshold = Number(document.getElementById('rating-filter')?.value ?? -1);
  const hasRating = ratingThreshold >= 0;
  const hasColor = colorFilters.size > 0;
  const hasKeywords = keywordFilters.length > 0;
  const hasFilename = filenameFilters.length > 0;
  const hasDate = dateFilter !== null || Boolean(dateFilterInput?.value.trim());
  return hasRating || hasColor || hasKeywords || hasFilename || hasDate;
}

function updateFilteredPhotosCount() {
  const countElement = document.getElementById('filtered-photos-count');
  const clearBtn = document.getElementById('btn-clear-all-filters');
  const isFiltered = hasActiveFilters();

  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !isFiltered);
  }

  if (countElement) {
    const translationKey = isFiltered ? '{count} photo filtered' : '{count} photo displayed';
    countElement.textContent = tp(translationKey, photos.length);
  }
}

function applyPhotoFilters({ keepState = false } = {}) {
  const ratingThreshold = Number(document.getElementById('rating-filter').value);
  // keepState : mise à jour en arrière-plan (synchronisation), la sélection et le défilement sont conservés.
  const keptPaths = keepState ? [...selectedIndices].map(index => photos[index]?.path).filter(Boolean) : [];
  const keptLastPath = keepState ? photos[lastSelectedIndex]?.path : null;
  const keptScrollTop = gridContainer.scrollTop;
  for (const node of renderedThumbnailNodes.values()) node.remove();
  renderedThumbnailNodes.clear();
  photos = loadedPhotos.filter(photo => (ratingThreshold < 0 || photo.rating > ratingThreshold)
    && keywordFilters.every(keyword => (photo.keywords || '').split(', ').includes(keyword))
    && matchesFilenameFilters(photo)
    && (colorFilters.size === 0 || colorFilters.has(photo.color_flag || 'none'))
    && matchesDateFilter(photo));
  photos.sort(comparePhotosForSort); // même liste pour la grille et la navigation en plein écran
  renderFilterSummaries();
  selectedIndices.clear();
  lastSelectedIndex = 0;
  gridContainer.scrollTop = 0;
  updateVirtualScroller();
  if (keepState) {
    const indexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
    for (const path of keptPaths) if (indexByPath.has(path)) selectedIndices.add(indexByPath.get(path));
    lastSelectedIndex = indexByPath.get(keptLastPath) ?? selectedIndices.values().next().value ?? 0;
    gridContainer.scrollTop = keptScrollTop;
    renderVisibleItems();
  }
  if (photos.length > 0) {
    if (selectedIndices.size === 0) selectedIndices.add(0);
    updateUIOnSelection();
  } else {
    renderPreview();
    clearFullscreenImage();
    updateRatingAction();
    document.getElementById('exif-caption').textContent = '-';
  }
  updateFilteredPhotosCount();
}

// Mots-clés du panneau d'infos sous forme d'étiquettes cliquables (même aspect que celles du filtre) : un clic remplace les mots-clés filtrés
// par celui-ci, Ctrl + clic l'ajoute à ceux déjà filtrés. Les autres filtres (note, couleur, nom de fichier, date) ne sont pas touchés.
// Le filtre compare les mots-clés tels que stockés : on filtre sur la valeur brute et on n'affiche décodé que le texte (entités HTML).
function renderInfoKeywords(photo) {
  const container = document.getElementById('exif-keywords');
  const words = (photo.keywords || '').split(', ').map(word => word.trim()).filter(Boolean);
  if (words.length === 0) {
    container.textContent = '-';
    return;
  }
  container.replaceChildren(...words.map(word => {
    const button = document.createElement('button');
    button.type = 'button';
    const active = keywordFilters.includes(word);
    button.className = `filter-tag tag-keyword${active ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(active));
    button.textContent = decodeHtmlEntities(word);
    button.title = t('Filter on this keyword (Ctrl+click: add to the filter)');
    button.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey) {
        if (!keywordFilters.includes(word)) keywordFilters.push(word);
      } else {
        keywordFilters = [word];
      }
      renderKeywordFilters();
      applyPhotoFilters();
    });
    return button;
  }));
}

function clearAllFilters() {
  // Réinitialise la note
  const ratingSelect = document.getElementById('rating-filter');
  if (ratingSelect) ratingSelect.value = '-1';

  // Réinitialise les couleurs
  colorFilters.clear();
  document.querySelectorAll('#color-filter-bar .color-square').forEach(btn => setColorSquareChecked(btn, false));

  // Réinitialise les mots-clés
  keywordFilters = [];
  const keywordInput = document.getElementById('keyword-filter-input');
  if (keywordInput) keywordInput.value = '';
  renderKeywordFilters();

  // Réinitialise les chaînes de nom de fichier
  filenameFilters = [];
  const filenameInput = document.getElementById('filename-filter-input');
  if (filenameInput) filenameInput.value = '';
  renderFilenameFilters();

  // Réinitialise la date
  dateFilterInput.value = '';
  dateFilter = null;
  updateDateFilterUI('');
  closeDatePicker();

  // Réapplique la liste sans aucun filtre
  applyPhotoFilters();
}

document.getElementById('btn-clear-all-filters')?.addEventListener('click', clearAllFilters);

function renderKeywordFilters() {
  const keywords = new Set();
  for (const photo of folderTreePhotos) for (const word of (photo.keywords || '').split(', ')) if (word.trim()) keywords.add(word.trim());
  const options = document.getElementById('keyword-options');
  options.replaceChildren(...[...keywords].sort((a, b) => a.localeCompare(b)).map(keyword => {
    const option = document.createElement('option'); option.value = keyword; return option;
  }));
  renderFilterTags();
}

function addKeywordFilter(value) {
  const keyword = value.trim();
  if (!keyword || keywordFilters.includes(keyword)) return;
  keywordFilters.push(keyword);
  document.getElementById('keyword-filter-input').value = '';
  renderKeywordFilters();
  applyPhotoFilters();
}

// FILTRE PAR NOM DE FICHIER : chaque chaîne validée (Entrée) doit figurer dans le nom du fichier (extension comprise), sans tenir compte de la casse.
const FILENAME_FILTER_PATTERN = /^[\p{L}\p{N}._-]{3,}$/u;

function matchesFilenameFilters(photo) {
  if (filenameFilters.length === 0) return true;
  const name = (photo.filename || photo.path.split(/[\\/]/).pop() || '').toLowerCase();
  return filenameFilters.every(text => name.includes(text.toLowerCase()));
}

function renderFilenameFilters() {
  renderFilterTags();
}

function addFilenameFilter(value) {
  const text = value.trim();
  if (!text) return;
  if (!FILENAME_FILTER_PATTERN.test(text)) {
    showWriteToast(t('Only words of at least 3 characters made of letters, digits and the characters "-", "_" and "." are accepted'));
    return;
  }
  document.getElementById('filename-filter-input').value = '';
  if (filenameFilters.some(item => item.toLowerCase() === text.toLowerCase())) return;
  filenameFilters.push(text);
  renderFilenameFilters();
  applyPhotoFilters();
}

// ACCORDÉON DES FILTRES : un seul groupe (Notes & Couleurs, Mots-clés & Nom de fichier, Date) est déplié à la fois.
// Replié, un groupe tient sur une ligne compacte (titre + résumé / étiquettes) cliquable pour le déplier ; un clic hors de la zone des filtres replie tout.
const filterGroups = [...document.querySelectorAll('.photo-filters .filter-group')];

function setExpandedFilterGroup(name) {
  for (const group of filterGroups) {
    const expanded = group.dataset.filterGroup === name;
    group.classList.toggle('expanded', expanded);
    group.querySelector('.filter-group-toggle').setAttribute('aria-expanded', String(expanded));
    group.querySelector('.filter-group-body').hidden = !expanded;
  }
  if (name !== 'date') closeDatePicker();
  fitCollapsedTags(); // la ligne repliée vient d'apparaître ou de disparaître : on la mesure à nouveau
}

for (const group of filterGroups) {
  group.querySelector('.filter-group-toggle').addEventListener('click', () => {
    setExpandedFilterGroup(group.classList.contains('expanded') ? null : group.dataset.filterGroup);
  });
}

// Le calendrier est placé dans <body> : il fait partie de la zone des filtres pour ce test.
document.addEventListener('pointerdown', event => {
  if (!filterGroups.some(group => group.classList.contains('expanded'))) return;
  const target = event.target;
  if (target instanceof Element && (target.closest('.photo-filters') || target.closest('.date-picker'))) return;
  setExpandedFilterGroup(null);
}, true);

// Étiquettes des mots-clés (bleu) et des noms de fichier (vert), sur une ligne commune : boutons à croix quand le groupe est déplié,
// simples étiquettes derrière le titre quand il est replié.
function renderFilterTags() {
  const expandedContainer = document.getElementById('filter-tags');
  const collapsedLine = document.getElementById('tags-collapsed-line');
  if (!expandedContainer || !collapsedLine) return;
  const entries = [
    ...keywordFilters.map(text => ({ kind: 'keyword', text })),
    ...filenameFilters.map(text => ({ kind: 'filename', text })),
  ];
  expandedContainer.replaceChildren(...entries.map(({ kind, text }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-tag tag-${kind}`;
    button.textContent = `${text} ×`;
    button.title = t('Remove filter {keyword}', { keyword: text });
    button.addEventListener('click', () => {
      if (kind === 'keyword') keywordFilters = keywordFilters.filter(item => item !== text);
      else filenameFilters = filenameFilters.filter(item => item !== text);
      renderFilterTags();
      applyPhotoFilters();
    });
    return button;
  }));
  collapsedLine.querySelectorAll('.filter-tag').forEach(node => node.remove());
  collapsedLine.append(...entries.map(({ kind, text }) => {
    const tag = document.createElement('span');
    tag.className = `filter-tag tag-${kind}`;
    tag.textContent = text;
    tag.title = t(kind === 'keyword' ? 'Keyword: {text}' : 'Filename: {text}', { text });
    return tag;
  }));
  fitCollapsedTags();
}

// Ligne repliée des étiquettes : au plus deux lignes. Si elles ne tiennent pas, les dernières sont masquées et remplacées par une
// étiquette « … » (d'une autre couleur) qui termine la deuxième ligne. Les lignes sont comptées d'après la position verticale des éléments
// (tous de même hauteur), ce qui suppose la ligne visible : une ligne masquée (groupe déplié) est mesurée quand elle réapparaît.
function fitCollapsedTags() {
  const line = document.getElementById('tags-collapsed-line');
  if (!line) return;
  line.querySelectorAll('.tag-more').forEach(node => node.remove());
  const tags = [...line.querySelectorAll('.filter-tag')];
  tags.forEach(tag => { tag.hidden = false; });
  if (!line.offsetParent || tags.length === 0) return;
  const title = line.querySelector('.filter-group-title');
  const countRows = nodes => new Set(nodes.map(node => node.offsetTop)).size;
  if (countRows([title, ...tags]) <= 2) return;
  const more = document.createElement('span');
  more.className = 'filter-tag tag-more';
  more.textContent = '…';
  line.append(more);
  let visibleCount = tags.length;
  while (visibleCount > 0 && countRows([title, ...tags.slice(0, visibleCount), more]) > 2) {
    visibleCount--;
    tags[visibleCount].hidden = true;
  }
  more.title = tags.slice(visibleCount).map(tag => tag.textContent).join(', ');
}

// La largeur de la ligne change avec la barre latérale (redimensionnement, repli) ou quand le groupe est replié : les étiquettes sont réparties à nouveau.
const tagsCollapsedLine = document.getElementById('tags-collapsed-line');
let tagsCollapsedLineWidth = 0;
if (tagsCollapsedLine && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (tagsCollapsedLine.clientWidth === tagsCollapsedLineWidth) return;
    tagsCollapsedLineWidth = tagsCollapsedLine.clientWidth;
    fitCollapsedTags();
  }).observe(tagsCollapsedLine);
}

// Bornes du filtre de date au format AAAAMMJJHHmmss -> « 01/05/2024 » ; l'heure n'est ajoutée que si elle diffère de celle par défaut de la borne (00:00:00 au début, 23:59:59 à la fin).
function formatDateFilterBound(key, isEnd) {
  const text = String(key).padStart(14, '0');
  const date = new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  const time = text.slice(8);
  const showTime = time !== (isEnd ? '235959' : '000000');
  return date.toLocaleDateString(getLanguage()) + (showTime ? ` ${time.slice(0, 2)}:${time.slice(2, 4)}` : '');
}

// Résumés affichés sur les lignes repliées : note (badge) et couleurs (pastilles), dates de début et de fin, étiquettes.
function renderFilterSummaries() {
  const ratingSelect = document.getElementById('rating-filter');
  const threshold = Number(ratingSelect.value);
  const ratingColorNodes = [];
  if (threshold >= 0) {
    const badge = document.createElement('span');
    badge.className = 'filter-tag tag-rating';
    badge.textContent = threshold === 4 ? '5 ★' : `≥ ${threshold + 1} ★`;
    badge.title = ratingSelect.selectedOptions[0]?.textContent ?? '';
    ratingColorNodes.push(badge);
  }
  for (const key of colorFilters) {
    const dot = document.createElement('span');
    dot.className = `flag-indicator flag-${key}`;
    dot.title = colorFlagLabels.get(key) ?? key;
    ratingColorNodes.push(dot);
  }
  document.getElementById('rating-color-summary').replaceChildren(...ratingColorNodes);

  const dateNodes = dateFilter ? [
    ['From {date}', formatDateFilterBound(dateFilter.from, false)],
    ['To {date}', formatDateFilterBound(dateFilter.to, true)],
  ].map(([key, date]) => {
    const tag = document.createElement('span');
    tag.className = 'filter-tag tag-date';
    tag.textContent = t(key, { date });
    return tag;
  }) : [];
  document.getElementById('date-summary').replaceChildren(...dateNodes);

  renderFilterTags();
}

function decodeHtmlEntities(text) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
  return doc.documentElement.textContent;
}

// ==========================================
// ARBORESCENCE & FILTRES
// ==========================================
function renderFolderTree() {
  folderTree.innerHTML = '';
  
  const allItem = document.createElement('li');
  allItem.className = `folder-tree-item ${currentFolderFilter === null ? 'active' : ''}`;
  allItem.innerHTML = `<span>📚</span> <span>${t('All photos')}</span>`;
  allItem.addEventListener('click', () => selectFolder(null));
  folderTree.appendChild(allItem);
  const roots = folders.map(folder => ({ path: folder.path.replace(/[\\/]+$/, ''), name: folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path, children: new Map() }));
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const addFolderToTree = parent => {
    const root = roots.find(candidate => {
      const rootPath = candidate.path.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalize(parent) === normalize(rootPath) || normalize(parent).startsWith(`${normalize(rootPath)}/`);
    });
    if (!root) return;
    const rootPath = root.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const relative = parent.slice(rootPath.length).replace(/^\//, '');
    let node = root;
    let currentPath = root.path;
    for (const segment of relative.split('/').filter(Boolean)) {
      currentPath += `/${segment}`;
      if (!node.children.has(segment)) node.children.set(segment, { path: currentPath, name: segment, children: new Map() });
      node = node.children.get(segment);
    }
  };
  for (const photo of (folderTreePhotos.length ? folderTreePhotos : loadedPhotos)) {
    const photoPath = photo.path.replace(/\\/g, '/');
    addFolderToTree(photoPath.slice(0, photoPath.lastIndexOf('/')));
  }
  // Dossiers créés depuis l'application et encore vides : l'arborescence est déduite des photos, ils n'y figureraient pas sinon.
  for (const folderPath of createdFolders) addFolderToTree(folderPath.replace(/\\/g, '/').replace(/\/+$/, ''));
  const renderNode = (node, parentElement, depth, isRoot = false) => {
    const li = document.createElement('li');
    li.className = `folder-tree-item ${currentFolderFilter && normalize(currentFolderFilter) === normalize(node.path) ? 'active' : ''}`;
    li.dataset.folderPath = node.path; // lu par le menu contextuel de l'arborescence (photo-actions.js)
    if (isRoot) li.dataset.folderRoot = '1'; // dossier suivi (et non sous-dossier) : message de confirmation de suppression
    li.style.paddingLeft = `${10 + depth * 16}px`;
    const hasChildren = node.children.size > 0;
    const key = normalize(node.path);
    const expanded = folderTreeExpanded.has(key) || (isRoot && !folderTreeInitialized);
    const toggle = document.createElement('button');
    toggle.className = 'folder-tree-toggle';
    toggle.textContent = hasChildren ? (expanded ? '▾' : '▸') : ' ';
    toggle.setAttribute('aria-label', t(expanded ? 'Collapse folder' : 'Expand folder'));
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      if (expanded) folderTreeExpanded.delete(key); else folderTreeExpanded.add(key);
      folderTreeInitialized = true;
      renderFolderTree();
    });
    const icon = document.createElement('span'); icon.textContent = '📁';
    const label = document.createElement('span'); label.textContent = node.name; label.title = node.path;
    li.append(toggle, icon, label);
    li.addEventListener('click', () => selectFolder(node.path));
    parentElement.appendChild(li);
    if (expanded) for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) renderNode(child, parentElement, depth + 1);
  };
  for (const root of roots) {
    if (!folderTreeInitialized) folderTreeExpanded.add(normalize(root.path));
    renderNode(root, folderTree, 0, true);
  }
  folderTreeInitialized = true;
}

const folderTreeExpanded = new Set();
const createdFolders = new Set(); // sous-dossiers créés pendant cette session (voir renderFolderTree)
let folderTreeInitialized = false;
// Appelé après la création d'un sous-dossier : il apparaît tout de suite dans l'arborescence, dossier parent déplié.
function addCreatedFolder(parentPath, name) {
  createdFolders.add(`${parentPath.replace(/[\\/]+$/, '')}/${name}`);
  folderTreeExpanded.add(parentPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  renderFolderTree();
}
function selectFolder(path) {
  currentFolderFilter = path;
  renderFolderTree();
  loadPhotos();
}

// ==========================================
// VIRTUAL SCROLLING
// ==========================================
// Ratio largeur/hauteur d'une photo : ratio appris depuis l'image chargée, sinon dimensions EXIF de la base, sinon 1.
function photoAspectRatio(photo) {
  return photo.aspectRatio || (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1);
}
// Dispose les photos [start, end[ (indices dans photos) à partir de la hauteur offsetY ; renvoie la hauteur occupée par ce groupe.
// Sans séparateur, c'est une seule plage couvrant toutes les photos ; avec des séparateurs, chaque groupe est disposé séparément (les lignes justifiées, les colonnes de la cascade et la grille carrée repartent à zéro).
// Taille maximale d'affichage : le plus grand côté d'une miniature ne dépasse jamais thumbnailSize (taille de la miniature en cache, au-delà elle serait floue).
function layoutPhotoRange(start, end, offsetY, width, gap) {
  if (end <= start) return 0;
  const count = end - start;
  const thumbailSizeCorrected = Math.floor(thumbnailSize / (window.devicePixelRatio || 1));
  if (thumbnailLayout === 'square') {
    columns = Math.max(1, Math.floor(width / thumbailSizeCorrected));
    const cellSize = Math.min(thumbailSizeCorrected, width / columns);
    for (let n = 0; n < count; n++) photoLayouts.push({ index: start + n, x: (n % columns) * cellSize, y: offsetY + Math.floor(n / columns) * cellSize, width: cellSize, height: cellSize });
    return Math.ceil(count / columns) * cellSize;
  } else if (thumbnailLayout === 'justified') {
    let y = offsetY;
    let index = start;
    while (index < end) {
      // Une photo de ratio r (largeur/hauteur) ne doit pas dépasser thumbnailSize sur son plus grand côté : sa hauteur est donc limitée à
      // thumbnailSize / r en paysage et à thumbnailSize en portrait. Le plafond de la ligne est le plus bas de ses photos.
      // On ajoute des photos jusqu'à ce que la hauteur qui remplit toute la largeur passe sous ce plafond : la hauteur des lignes
      // varie un peu sous thumbnailSize, mais aucune miniature n'est agrandie au-delà de sa taille réelle.
      const row = [];
      let ratioSum = 0;
      let rowMaxHeight = Infinity;
      while (index + row.length < end) {
        const ratio = photoAspectRatio(photos[index + row.length]);
        row.push({ index: index + row.length, ratio });
        ratioSum += ratio;
        rowMaxHeight = Math.min(rowMaxHeight, thumbailSizeCorrected / Math.max(1, ratio));
        if ((width - gap * (row.length - 1)) / ratioSum <= rowMaxHeight + 0.01) break;
      }
      // Ligne complète : les largeurs sont calculées depuis la largeur utile, donc la ligne remplit exactement le conteneur.
      // Dernière ligne d'un groupe, avec trop peu de photos pour atteindre le plafond : elle n'est pas étirée, sa hauteur est plafonnée et ses photos restent alignées à gauche.
      const available = Math.max(1, width - gap * (row.length - 1));
      const fillHeight = available / ratioSum;
      const height = fillHeight <= rowMaxHeight + 0.01 ? fillHeight : rowMaxHeight;
      maximumPhotoHeight = Math.max(maximumPhotoHeight, height);
      let x = 0;
      for (const item of row) {
        const itemWidth = item.ratio * height;
        photoLayouts.push({ index: item.index, x, y, width: itemWidth, height });
        x += itemWidth + gap;
      }
      y += height + gap;
           index += row.length;
          }
    return Math.max(0, y - offsetY - gap);
  } else {
    // Nombre de colonnes arrondi au-dessus : la largeur d'une colonne ne dépasse jamais thumbnailSize.
    columns = Math.max(1, Math.ceil((width + gap) / (thumbailSizeCorrected + gap)));
    const columnWidth = (width - gap * (columns - 1)) / columns;
    const columnBottoms = Array(columns).fill(0);
    const placed = [];
    for (let i = start; i < end; i++) {
      let column = 0;
      for (let c = 1; c < columns; c++) if (columnBottoms[c] < columnBottoms[column]) column = c;
      const photo = photos[i];
      const ratio = Math.max(0.2, Math.min(5, photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1));
      // Photo en portrait : sa hauteur est plafonnée à thumbnailSize, elle se réduit alors et se centre dans sa colonne.
      const height = Math.min(columnWidth / ratio, thumbailSizeCorrected);
      const itemWidth = height * ratio;
      const y = columnBottoms[column];
      placed.push({ index: i, x: column * (columnWidth + gap) + (columnWidth - itemWidth) / 2, y: offsetY + y, width: itemWidth, height });
      columnBottoms[column] = y + height + gap;
      maximumPhotoHeight = Math.max(maximumPhotoHeight, height);
    }
    placed.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const item of placed) photoLayouts.push(item);
    return Math.max(0, ...columnBottoms) - gap;
  }
}

// Hauteur d'une ligne de séparation en pixels : mesurée sur un élément invisible pour accepter n'importe quelle unité CSS dans --group-separator-height.
let separatorProbe = null;
function separatorHeight() {
  if (!separatorProbe) {
    separatorProbe = document.createElement('div');
    separatorProbe.className = 'group-separator-probe';
    separatorProbe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(separatorProbe);
  }
  return Math.max(1, separatorProbe.offsetHeight);
}

function updateVirtualScroller() {
  const width = Math.max(1, gridContainer.clientWidth - 2 * GRID_SIDE_MARGIN);
  const gap = thumbnailLayout === 'justified' ? 0 : 6;
  photoLayouts = [];
  separatorLayouts = [];
  maximumPhotoHeight = thumbnailSize;
  const groups = computePhotoGroups();
  const headerHeight = groups.length ? separatorHeight() : 0;
  let y = 0;
  if (!groups.length) {
    y = layoutPhotoRange(0, photos.length, 0, width, gap);
  } else {
    groups.forEach((group, groupIndex) => {
      separatorLayouts.push({ group: groupIndex, y, height: headerHeight, label: group.label, title: group.title });
      y += headerHeight;
      y += layoutPhotoRange(group.start, group.end, y, width, gap);
      if (groupIndex < groups.length - 1) y += gap;
    });
  }
  layoutContentHeight = y;
  scrollContent.style.height = `${Math.max(0, layoutContentHeight)}px`;
  renderVisibleItems();
}

function renderVisibleItems() {
  const scrollTop = gridContainer.scrollTop;
  const overscan = Math.round(gridContainer.clientHeight * THUMBNAIL_OVERSCAN_SCREENS);
  const top = Math.max(0, scrollTop - overscan - maximumPhotoHeight);
  const bottom = scrollTop + gridContainer.clientHeight + overscan;
  let low = 0, high = photoLayouts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (photoLayouts[middle].y < top) low = middle + 1; else high = middle;
  }
  const visible = new Set();
  for (let p = low; p < photoLayouts.length && photoLayouts[p].y < bottom; p++) {
    const layout = photoLayouts[p];
    const i = layout.index;
    const photo = photos[i];
    if (!photo) continue;
    visible.add(i);
    let div = renderedThumbnailNodes.get(i);
    if (!div) {
      div = document.createElement('div');
      div.className = 'thumbnail';
      div.dataset.index = String(i);
      const inner = document.createElement('div'); inner.className = 'thumbnail-inner';
      const thumbnailImage = document.createElement('img');
      thumbnailImage.alt = '';
      thumbnailImage.draggable = false;
      thumbnailImage.decoding = 'async';
      loadThumbnail(thumbnailImage, photo.path, photo);
      const overlay = document.createElement('div'); overlay.className = 'meta-overlay';
      const stars = document.createElement('span'); stars.className = 'thumbnail-rating';
      const flag = document.createElement('span'); flag.className = `flag-indicator flag-${photo.color_flag}`;
      overlay.append(stars, flag); inner.append(thumbnailImage, overlay); div.appendChild(inner);
      div._ratingLabel = stars; div._flag = flag; div._thumbnailImage = thumbnailImage;
      div._selected = false; div._transform = '';
      div.addEventListener('click', event => handleSelection(Number(div.dataset.index), event));
      div.addEventListener('dblclick', () => openFullscreen(Number(div.dataset.index)));
      renderedThumbnailNodes.set(i, div);
      scrollContent.appendChild(div);
    }
    const transform = `translate3d(${layout.x}px, ${layout.y}px, 0)`;
    if (div._transform !== transform) { div.style.transform = transform; div._transform = transform; }
    div._y = layout.y; // utilisé pour prioriser la génération des miniatures proches de la zone visible
    if (div._width !== layout.width) { div.style.width = `${layout.width}px`; div._width = layout.width; }
    if (div._height !== layout.height) { div.style.height = `${layout.height}px`; div._height = layout.height; }
    const padding = thumbnailLayout === 'justified' ? '0' : '4px';
    if (div._padding !== padding) { div.style.padding = padding; div._padding = padding; }
    div.classList.toggle('justified', thumbnailLayout === 'justified');
    const objectFit = thumbnailLayout === 'square' ? 'cover' : 'contain';
    if (div._objectFit !== objectFit) { div._thumbnailImage.style.objectFit = objectFit; div._objectFit = objectFit; }
    const selected = selectedIndices.has(i);
    if (div._selected !== selected) { div.classList.toggle('selected', selected); div._selected = selected; }
    const stars = '★'.repeat(photo.rating);
    if (div._ratingLabel.textContent !== stars) div._ratingLabel.textContent = stars;
    const flagClass = `flag-indicator flag-${photo.color_flag}`;
    if (div._flag.className !== flagClass) div._flag.className = flagClass;
  }
  renderVisibleSeparators(top, bottom);
  for (const [index, node] of renderedThumbnailNodes) {
    if (!visible.has(index)) { node.remove(); renderedThumbnailNodes.delete(index); }
  }
}

// Lignes de séparation visibles (dates ou dossiers) : créées à l'arrivée dans la zone affichée, retirées quand elles en sortent, comme les miniatures.
// Les nœuds sont indexés par numéro de groupe et mis à jour si le texte ou la position change (changement de tri, de filtre ou de langue).
function renderVisibleSeparators(top, bottom) {
  const visible = new Set();
  for (const separator of separatorLayouts) {
    if (separator.y + separator.height < top) continue;
    if (separator.y > bottom) break;
    visible.add(separator.group);
    let node = renderedSeparatorNodes.get(separator.group);
    if (!node) {
      node = document.createElement('div');
      node.className = 'group-separator';
      node._text = document.createElement('span');
      node._text.className = 'group-separator-label';
      node.appendChild(node._text);
      renderedSeparatorNodes.set(separator.group, node);
      scrollContent.appendChild(node);
    }
    if (node._label !== separator.label) { node._text.textContent = separator.label; node._label = separator.label; }
    if (node._title !== separator.title) { node.title = separator.title; node._title = separator.title; }
    const transform = `translate3d(0, ${separator.y}px, 0)`;
    if (node._transform !== transform) { node.style.transform = transform; node._transform = transform; }
    if (node._height !== separator.height) { node.style.height = `${separator.height}px`; node._height = separator.height; }
  }
  for (const [group, node] of renderedSeparatorNodes) {
    if (!visible.has(group)) { node.remove(); renderedSeparatorNodes.delete(group); }
  }
}

gridContainer.addEventListener('scroll', () => {
  if (scrollRenderPending) return;
  scrollRenderPending = true;
  requestAnimationFrame(() => { scrollRenderPending = false; renderVisibleItems(); });
});
window.addEventListener('resize', updateVirtualScroller);

// ==========================================
// GESTION DU PLEIN ÉCRAN ET NAVIGATION
// ==========================================
function openFullscreen(index) {
  lastSelectedIndex = index;
  selectedIndices.clear();
  selectedIndices.add(index);
  updateUIOnSelection();
  isFullscreen = true;
  fullscreenRatingPinned = false;
  fullscreenRating.classList.add('hidden');
  fullscreenView.classList.remove('hidden');
  // Toujours en vue entière à l'ouverture (le zoom d'une précédente ouverture n'est pas conservé).
  fullscreenSlot.zoom = null;
  fullscreenSlot.center = { x: 0.5, y: 0.5 };
  layoutFullscreenSlot();
  preloadFullscreenImages(index);
  updateFullscreenInfo();
}

function closeFullscreen() {
  isFullscreen = false;
  fullscreenDrag = null;
  fullscreenView.classList.remove('dragging');
  fullscreenView.classList.add('hidden');
  clearTimeout(fullscreenRatingTimeout);
  fullscreenRatingPinned = false;
}

export function getIsFullscreen() {
  return isFullscreen;
}

// Positionne et zoome l'image du plein écran avec la même logique que l'aperçu (rien à faire tant que la fenêtre est masquée).
function layoutFullscreenSlot() {
  if (!isFullscreen) return;
  layoutPreviewSlot(fullscreenSlot);
  fullscreenView.classList.toggle('zoomed', fullscreenSlot.zoom !== null);
}

// Affiche la photo en plein écran. Zoom et position repartent de la vue entière seulement quand l'image change : un simple
// changement de note rappelle cette fonction avec la même image. L'image précédente reste affichée jusqu'à ce que la nouvelle soit
// prête, puis dimensions, zoom et position sont appliqués d'un coup (pas d'image étirée entre deux photos).
function showFullscreenPhoto(photo, url) {
  fullscreenSlot.photo = photo;
  if (fullscreenSlot.url === url) { updateFullscreenInfo(); return; } // même image (ex. changement de note) : la photo associée a pu changer
  fullscreenSlot.url = url;
  const token = ++fullscreenLoadToken;
  const apply = loaded => {
    if (token !== fullscreenLoadToken) return; // une autre photo a été demandée entre-temps
    fullscreenSlot.naturalWidth = loaded.naturalWidth;
    fullscreenSlot.naturalHeight = loaded.naturalHeight;
    fullscreenSlot.zoom = null;
    fullscreenSlot.center = { x: 0.5, y: 0.5 };
    fullscreenImg.style.width = `${loaded.naturalWidth}px`;
    fullscreenImg.style.height = `${loaded.naturalHeight}px`;
    updateFullscreenInfo(); // les informations changent en même temps que l'image affichée
    fullscreenImg.src = url;
    layoutFullscreenSlot();
  };
  const probe = new Image();
  probe.onload = () => apply(probe);
  probe.onerror = () => {
    if (token !== fullscreenLoadToken) return;
    updateFullscreenInfo();
    // Image illisible : l'élément affiche l'erreur, ce qui lance la vérification de fichier manquant (écouteur « error » plus bas).
    fullscreenSlot.naturalWidth = 0;
    fullscreenSlot.naturalHeight = 0;
    fullscreenSlot.zoom = null;
    fullscreenImg.src = url;
  };
  probe.src = url;
  if (probe.complete && probe.naturalWidth > 0) { // déjà en mémoire (aperçu, préchargement) : pas d'attente
    probe.onload = null;
    apply(probe);
  }
}

function clearFullscreenImage() {
  fullscreenLoadToken++;
  fullscreenSlot.photo = null;
  fullscreenSlot.url = '';
  fullscreenSlot.naturalWidth = 0;
  fullscreenSlot.naturalHeight = 0;
  fullscreenSlot.zoom = null;
  fullscreenImg.src = '';
  updateFullscreenInfo();
  layoutFullscreenSlot();
}

function navigatePhoto(direction) {
  navigateToPhotoIndex(lastSelectedIndex + direction);
}

function navigateToPhotoIndex(index) {
  if (photos.length === 0) return;
  const newIndex = Math.max(0, Math.min(photos.length - 1, index));
  if (newIndex === lastSelectedIndex) return;
  
  lastSelectedIndex = newIndex;
  selectedIndices.clear();
  selectedIndices.add(newIndex);
  updateUIOnSelection();
  preloadFullscreenImages(newIndex);
}

const fullscreenRating = document.getElementById('fullscreen-rating');
function showFullscreenRatingForAWhile() {
  fullscreenRating.classList.remove('hidden');
  clearTimeout(fullscreenRatingTimeout);
  if (!fullscreenRatingPinned) fullscreenRatingTimeout = setTimeout(() => fullscreenRating.classList.add('hidden'), 3000);
}

function updateFullscreenRatingStars() {
  const rating = photos[lastSelectedIndex]?.rating || 0;
  fullscreenRating.querySelectorAll('button').forEach(button => button.classList.toggle('active', Number(button.dataset.rating) <= rating));
}

// INFORMATIONS SUR LA PHOTO EN PLEIN ÉCRAN (touche D) : nom de fichier (haut, centre), rang dans la liste parcourue (haut, droite),
// EXIF sur deux lignes (bas, gauche) et date de prise de vue en toutes lettres (bas, centre). Le choix affiché / masqué est mémorisé.
let fullscreenInfoVisible = false;
try { fullscreenInfoVisible = localStorage.getItem('fullscreenInfoVisible') === 'true'; } catch { /* stockage indisponible : masqué par défaut */ }
const fullscreenInfo = document.getElementById('fullscreen-info');
const fullscreenInfoName = document.getElementById('fullscreen-info-name');
const fullscreenInfoRank = document.getElementById('fullscreen-info-rank');
const fullscreenInfoExifLines = [...document.querySelectorAll('#fullscreen-info-exif > div')];
const fullscreenInfoDate = document.getElementById('fullscreen-info-date');

// « samedi 12 septembre 2026, 12h36 » (l'heure n'est ajoutée que si la date EXIF en contient une).
function formatFullscreenDate(photo) {
  const key = photoTimeKey(photo);
  if (key === null || key === undefined) return '';
  const text = String(key).padStart(14, '0');
  const language = getLanguage();
  const date = new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  const day = date.toLocaleDateString(language, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const hasTime = /\d{4}\D?\d{2}\D?\d{2}\D+\d{2}/.test(String(photo.date_taken || ''));
  if (!hasTime) return day;
  const hour = text.slice(8, 10);
  const minute = text.slice(10, 12);
  return `${day}, ${language === 'fr' ? `${Number(hour)}h${minute}` : `${hour}:${minute}`}`;
}

// Fabricant + modèle, sans répéter le fabricant quand le modèle le contient déjà (« NIKON CORPORATION » + « NIKON D850 » -> « NIKON D850 »).
function fullscreenCameraName(photo) {
  const make = (photo.manufacturer || '').trim();
  const model = (photo.camera_model || '').trim();
  if (!model) return make;
  const makeWord = make.split(/\s+/)[0].toLowerCase();
  return make && !model.toLowerCase().startsWith(makeWord) ? `${make} ${model}` : model;
}

function updateFullscreenInfo() {
  fullscreenView.classList.toggle('show-info', fullscreenInfoVisible);
  fullscreenInfo.classList.toggle('hidden', !fullscreenInfoVisible);
  if (!fullscreenInfoVisible) return;
  const photo = fullscreenSlot.photo;
  if (!photo) {
    fullscreenInfoName.textContent = fullscreenInfoRank.textContent = fullscreenInfoDate.textContent = '';
    fullscreenInfoExifLines.forEach(line => { line.textContent = ''; line.hidden = true; });
    return;
  }
  fullscreenInfoName.textContent = photo.filename || photo.path.split(/[\\/]/).pop() || '';
  const index = photos[lastSelectedIndex] === photo ? lastSelectedIndex : photos.indexOf(photo);
  fullscreenInfoRank.textContent = index >= 0 ? `${index + 1}/${photos.length}` : '';
  fullscreenInfoDate.textContent = formatFullscreenDate(photo);
  const lines = [
    [fullscreenCameraName(photo), (photo.lens_model || '').trim()],
    [photo.focal_length, photo.shutter_speed ? formatShutterSpeed(photo.shutter_speed) : '', photo.iso ? `ISO ${photo.iso}` : ''],
  ].map(parts => parts.filter(Boolean).join(' · '));
  fullscreenInfoExifLines.forEach((line, i) => { line.textContent = lines[i] || ''; line.hidden = !lines[i]; });
}

function toggleFullscreenInfo() {
  fullscreenInfoVisible = !fullscreenInfoVisible;
  try { localStorage.setItem('fullscreenInfoVisible', String(fullscreenInfoVisible)); } catch { /* non mémorisé */ }
  updateFullscreenInfo();
}

function preloadFullscreenImages(index) {
  const keep = new Set();
  for (let i = Math.max(0, index - 2); i <= Math.min(photos.length - 1, index + 2); i++) {
    keep.add(i);
    if (!fullscreenImageCache.has(i)) {
      const image = new Image();
      fullscreenImageCache.set(i, image);
      const photoPath = photos[i].path;
      const photo = photos[i];
      image.onerror = () => checkPhotoMissing(photoPath);
      getPhotoDisplayUrl(photo).then(url => {
        if (fullscreenImageCache.get(i) === image) {
          image.src = url;
        }
      });
    }
  }
  for (const cachedIndex of fullscreenImageCache.keys()) if (!keep.has(cachedIndex)) fullscreenImageCache.delete(cachedIndex);
}

// Navigation à la molette en plein écran ; avec Ctrl, la molette zoome autour du curseur (comme dans l'aperçu) au lieu de changer de photo.
fullscreenView.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    const steps = wheelZoomSteps(e);
    if (steps) zoomPreviewSteps(-steps, previewAnchorAt(fullscreenSlot, e.clientX, e.clientY), fullscreenSlot);
    return;
  }
  if (e.deltaY > 0) {
    // Molette vers le bas / droite -> Photo suivante
    navigateToPhotoIndex(lastSelectedIndex + 1);
  } else {
    // Molette vers le haut / gauche -> Photo précédente
    navigateToPhotoIndex(lastSelectedIndex - 1);
  }
}, { passive: false });

// Double-clic pour quitter le plein écran
fullscreenView.addEventListener('dblclick', closeFullscreen);

// Plein écran zoomé : on déplace l'image en la faisant glisser à la souris (comme dans l'aperçu) ; le zoom se commande au clavier (+ / - / *) ou par Ctrl + molette.
fullscreenView.addEventListener('pointerdown', event => {
  if (event.button !== 0 || fullscreenSlot.zoom === null) return;
  if (event.target instanceof Element && event.target.closest('#fullscreen-rating')) return;
  fullscreenDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  fullscreenView.setPointerCapture(event.pointerId);
  fullscreenView.classList.add('dragging');
});
fullscreenView.addEventListener('pointermove', event => {
  if (!fullscreenDrag || event.pointerId !== fullscreenDrag.pointerId) return;
  const dx = event.clientX - fullscreenDrag.x;
  const dy = event.clientY - fullscreenDrag.y;
  fullscreenDrag.x = event.clientX;
  fullscreenDrag.y = event.clientY;
  const slot = fullscreenSlot;
  if (slot.zoom === null || !(slot.displayWidth > 0 && slot.displayHeight > 0)) return;
  slot.center = clampPreviewCenter(slot, slot.center.x - dx / slot.displayWidth, slot.center.y - dy / slot.displayHeight);
  layoutFullscreenSlot();
});
function endFullscreenDrag(event) {
  if (!fullscreenDrag || event.pointerId !== fullscreenDrag.pointerId) return;
  fullscreenDrag = null;
  fullscreenView.classList.remove('dragging');
}
fullscreenView.addEventListener('pointerup', endFullscreenDrag);
fullscreenView.addEventListener('pointercancel', endFullscreenDrag);
// Redimensionnement de la fenêtre pendant le plein écran : la vue entière et le centre sont recalculés.
new ResizeObserver(() => layoutFullscreenSlot()).observe(fullscreenView);
// Image qui ne se charge pas (fichier supprimé hors de l'application) : vérification puis retrait du catalogue si besoin.
// Le backend revérifie sur le disque : une erreur sur une photo qui existe encore ne retire rien.
fullscreenImg.addEventListener('error', () => {
  const path = photos[lastSelectedIndex]?.path;
  if (path && fullscreenImg.getAttribute('src')) checkPhotoMissing(path);
});
fullscreenRating.addEventListener('click', event => event.stopPropagation());
fullscreenRating.querySelectorAll('button').forEach(button => button.addEventListener('click', () => setSelectionRating(Number(button.dataset.rating))));

// ==========================================
// SELECTION MULTIPLE
// ==========================================
function handleSelection(index, event) {
  if (event.shiftKey) {
    const start = Math.min(lastSelectedIndex, index);
    const end = Math.max(lastSelectedIndex, index);
    const direction = index >= lastSelectedIndex ? 1 : -1;
    let lastAdded = lastSelectedIndex;
    let limited = false;
    for (let i = lastSelectedIndex; i >= start && i <= end; i += direction) {
      if (!canAddToSelection(i)) { limited = true; break; }
      selectedIndices.add(i);
      lastAdded = i;
    }
    if (limited) showCompareLimitToast();
    lastSelectedIndex = limited ? lastAdded : index;
  } else if (event.ctrlKey) {
    if (selectedIndices.has(index)) selectedIndices.delete(index);
    else if (canAddToSelection(index)) selectedIndices.add(index);
    else { showCompareLimitToast(); return; }
    lastSelectedIndex = index;
  } else {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
  }
  updateUIOnSelection();
}

// Ctrl+A (hors mode Comparer) : sélectionne toutes les photos affichées dans la grille, ou les désélectionne toutes si elles le sont déjà.
function toggleSelectAllPhotos() {
  if (photos.length === 0) return;
  if (selectedIndices.size === photos.length) {
    selectedIndices.clear();
  } else {
    for (let index = 0; index < photos.length; index++) selectedIndices.add(index);
    if (!selectedIndices.has(lastSelectedIndex)) lastSelectedIndex = 0;
  }
  updateUIOnSelection();
}

function updateUIOnSelection() {
  pruneCompareSubSelection();
  renderVisibleItems(); 
  updateRatingAction();
  updateColorAction();
  renderPreview();
  if (selectedIndices.size > 0 && photos[lastSelectedIndex]) {
    const photo = photos[lastSelectedIndex];
    
    getPhotoDisplayUrl(photo).then(imgUrl => {
      if (photos[lastSelectedIndex] === photo) {
        showFullscreenPhoto(photo, imgUrl);
      }
    });

    updateFullscreenRatingStars();
    if (isFullscreen) preloadFullscreenImages(lastSelectedIndex);

    document.getElementById('exif-filename').textContent = photo.filename || photo.path.split(/[\\/]/).pop() || '-';
    document.getElementById('exif-date').textContent = photo.date_taken || '-';
    document.getElementById('exif-manufacturer').textContent = photo.manufacturer || '-';
    document.getElementById('exif-model').textContent = photo.camera_model || '-';
    document.getElementById('exif-lens').textContent = photo.lens_model || '-';
    document.getElementById('exif-focal').textContent = photo.focal_length || '-';
    document.getElementById('exif-aperture').textContent = formatAperture(photo.aperture);
    document.getElementById('exif-shutter').textContent = formatShutterSpeed(photo.shutter_speed);
    document.getElementById('exif-iso').textContent = photo.iso ? photo.iso.toString() : '-';
    showPhotoDimensions(photo);
    document.getElementById('exif-size').textContent = `${(photo.file_size / 1024 / 1024).toFixed(2)} MB`;
    document.getElementById('exif-rating').textContent = photo.rating > 0 ? `${'★'.repeat(photo.rating)} (${photo.rating}/5)` : '-';
    document.getElementById('exif-color').textContent = colorFlagLabels.get(photo.color_flag) || '-';
    renderInfoKeywords(photo);
    document.getElementById('exif-caption').textContent = decodeHtmlEntities(photo.caption) || '-';
  }
}

// Normalise ouverture (« f/4 ») et vitesse (« 1/100 s »), y compris les valeurs déjà en base avec un préfixe ou un suffixe en double.
function formatAperture(value) {
  const text = String(value || '').trim().replace(/^(f\/)+/i, '');
  return text ? `f/${text}` : '-';
}

function formatShutterSpeed(value) {
  const text = String(value || '').trim().replace(/\s*s+$/i, '');
  return text ? `${text} s` : '-';
}

// Affiche les dimensions ; si la base n'en a pas (0 x 0), on les apprend depuis l'image réelle.
function showPhotoDimensions(photo) {
  const element = document.getElementById('exif-dim');
  const fromDatabase = photo.width > 0 && photo.height > 0;
  const width = fromDatabase ? photo.width : photo.measuredWidth;
  const height = fromDatabase ? photo.height : photo.measuredHeight;
  if (width > 0 && height > 0) {
    element.textContent = `${width} x ${height} (${(width * height / 1000000).toFixed(1)} MP)`;
    return;
  }
  element.textContent = '-';
  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth <= 0 || probe.naturalHeight <= 0) return;
    photo.measuredWidth = probe.naturalWidth;
    photo.measuredHeight = probe.naturalHeight;
    if (photos[lastSelectedIndex] === photo) showPhotoDimensions(photo);
  };
  //probe.src = photoUrl(photo);
  // rempalcement pour extracteur raw
  getPhotoDisplayUrl(photo).then(url => {
    probe.src = url;
  });
  // fin de rempalacement
}


function updateRatingAction() {
  const panel = document.getElementById('selection-actions');
  if (selectedIndices.size === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const count = selectedIndices.size;
  const countElement = document.getElementById('selection-count');
  if (countElement) countElement.textContent = tp('{count} photo selected', count);

  const selectedPhoto = commandReferencePhoto(); // en mode Comparer avec plusieurs photos : celle de la sous-sélection
  const rating = selectedPhoto?.rating || 0;
  document.querySelectorAll('#selection-rating-stars button').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.rating) <= rating);
  });
}



let writeToastTimeout = null;

function showWriteToast(message, isWriting = false) {
  const toast = document.getElementById('write-toast');
  if (!toast) return;
  clearTimeout(writeToastTimeout);
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.classList.toggle('writing', isWriting);
  if (!isWriting) writeToastTimeout = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// Carré de couleur cliquable, utilisé par la barre de filtre et par la barre d'écriture.
function createColorSquare(flag) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `color-square flag-${flag.key}`;
  button.dataset.flag = flag.key;
  button.title = t(flag.label);
  button.setAttribute('aria-label', t(flag.label));
  // Suivi du changement de langue par applyTranslations().
  button.setAttribute('data-i18n-title', flag.label);
  button.setAttribute('data-i18n-aria-label', flag.label);
  button.setAttribute('aria-pressed', 'false');
  return button;
}

function setColorSquareChecked(button, checked) {
  button.classList.toggle('checked', checked);
  button.setAttribute('aria-pressed', String(checked));
}

// Barre d'écriture : met en évidence la couleur de la photo de référence de la sélection (une seule couleur possible).
function updateColorAction() {
  if (selectedIndices.size === 0) return;
  const selectedPhoto = commandReferencePhoto();
  const flag = selectedPhoto?.color_flag || 'none';
  document.querySelectorAll('#selection-color-flags button').forEach(button => setColorSquareChecked(button, button.dataset.flag === flag));
}

async function setSelectionColorFlag(flag) {
  const targets = commandTargetPhotos(); // en mode Comparer avec plusieurs photos : la sous-sélection uniquement
  if (!targets.length) {
    if (isCompareMultiple()) notifyNoCompareTarget();
    return;
  }
  // Comme pour la note : si toutes les photos sélectionnées ont déjà cette couleur, on l'efface.
  const finalFlag = targets.every(photo => (photo.color_flag || 'none') === flag) ? 'none' : flag;
  showWriteToast(finalFlag === 'none'
    ? tp('Removing color for {count} file…', targets.length)
    : tp('Writing {count} file (color: {color})…', targets.length, { color: colorFlagLabels.get(finalFlag) }), true);
  // Seule la couleur est envoyée : la note de chaque fichier n'est pas réécrite.
  const results = await Promise.allSettled(targets.map(photo => invoke('update_photo_metadata', {
    id: photo.id,
    path: photo.path,
    colorFlag: finalFlag,
  })));
  const successful = results.flatMap((result, index) => result.status === 'fulfilled' ? [targets[index]] : []);
  const failures = results.filter(result => result.status === 'rejected');
  for (const photo of successful) photo.color_flag = finalFlag;
  updateUIOnSelection();
  const successMessage = finalFlag === 'none'
    ? tp('Color removed for {count} file', successful.length)
    : tp('{count} file modified', successful.length);
  showWriteToast(`${successMessage}${failures.length ? ` · ${tp('{count} failure', failures.length)}` : ''}`);
}

async function setSelectionRating(rating) {
  const targets = commandTargetPhotos(); // en mode Comparer avec plusieurs photos : la sous-sélection uniquement
  if (!targets.length) {
    if (isCompareMultiple()) notifyNoCompareTarget();
    return;
  }
  // Si toutes les photos sélectionnées ont déjà exactement cette note, 
  // on considère qu'on veut l'effacer (passer à 0).
  const allAlreadyHaveRating = targets.every(photo => photo.rating === rating);
  const finalRating = allAlreadyHaveRating ? 0 : rating;
  const actionText = finalRating === 0 ? t('Removing rating') : tp('Writing {count} file (rating: {rating})…', targets.length, { rating: finalRating });
  showWriteToast(actionText, true);
  const results = await Promise.allSettled(targets.map(photo => invoke('update_photo_metadata', {
      id: photo.id,
      path: photo.path,
      rating: finalRating,
  })));
  const successful = results.flatMap((result, index) => result.status === 'fulfilled' ? [targets[index]] : []);
  const failures = results.filter(result => result.status === 'rejected');
  for (const photo of successful) photo.rating = finalRating;
  updateUIOnSelection();
  if (isFullscreen && successful.length) showFullscreenRatingForAWhile();
  updateFullscreenRatingStars();
  const successMessage = finalRating === 0 
    ? tp('Rating removed for {count} file', successful.length)
    : tp('{count} file modified', successful.length);
    showWriteToast(`${successMessage}${failures.length ? ` · ${tp('{count} failure', failures.length)}` : ''}`);
}

// ==========================================
// Keyboard shortcuts Memo
// ==========================================
// +      : Zoom in
// -      : Zoom out
// *      : Zoom to full size / Fit to window
// 0-5    : Rate
// A      : Select / deselect all in compare mode
// Ctrl+A : Select/Deselect All
// C      : Copy to
// Ctrl+C : copy to clipboard
// D      : Info display in fullscreen
// Ctrl+D : Debug to console
// E      : Show in explorer
// F      : Fullscreen toggle
// H      : Shortcut guide
// I      : Info sheet
// J      : Info panel
// N      : Navigation/Filters panel
// P      : Preview panel
// R      : Rating bar in fullscreen
// S      : Resize
// X      : Compare mode
// F11    : immersive mode
// Del    : Delete
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  // Ctrl+C : copie les photos sélectionnées dans le presse-papiers de l'OS. Traité avant le raccourci « C » seul (Copier vers…),
  // qui ne doit pas s'ouvrir sur Ctrl+C. Ignoré quand une fenêtre (Paramètres, Guide, Tri…) est ouverte.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
    if (!document.querySelector('.modal:not(.hidden)')) {
      const selectedPhotos = commandTargetIndices().sort((a, b) => a - b).map(index => photos[index]).filter(Boolean); // mode Comparer avec plusieurs photos : sous-sélection
      if (selectedPhotos.length > 0) {
        e.preventDefault();
        copyPhotosToClipboard(selectedPhotos);
      } else if (isCompareMultiple()) {
        e.preventDefault();
        notifyNoCompareTarget();
      }
    }
    return;
  }
  // Ctrl+A : tout sélectionner / tout désélectionner dans la grille. Sans effet en mode Comparer (A seul y gère la sous-sélection), en plein écran ou derrière une fenêtre ouverte.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    if (!compareMode && !isFullscreen && !document.querySelector('.modal:not(.hidden)')) toggleSelectAllPhotos();
    return;
  }
  // CTrl+D debug to console
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
    console.log("Display Scaling Ratio: ", window.devicePixelRatio);
  }
  // Show rating bar Shortcut
  if (e.key.toLowerCase() === 'r' && isFullscreen) {
    fullscreenRatingPinned = !fullscreenRatingPinned;
    clearTimeout(fullscreenRatingTimeout);
    if (fullscreenRatingPinned) fullscreenRating.classList.remove('hidden');
    else fullscreenRating.classList.add('hidden');
    return;
  }
  // H : affiche / masque le guide des raccourcis (la modale ouverte aussi depuis les Paramètres) ; il se ferme avec H même s'il est ouvert par-dessus les Paramètres.
  if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    if (!guideModal.classList.contains('hidden')) { e.preventDefault(); closeGuide(); return; }
    if (!document.querySelector('.modal:not(.hidden)')) { e.preventDefault(); openGuide(); return; }
  }
  // Informations sur la photo (nom, date, EXIF, rang) en plein écran
  if (e.key.toLowerCase() === 'd' && isFullscreen && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal:not(.hidden)')) {
    toggleFullscreenInfo();
    return;
  }
  // Modale info
  if (e.key.toLowerCase() === 'i') {
    console.log("Touche I pressée, photo active :", photos[lastSelectedIndex], lastSelectedIndex);
    console.log("lasSelectedIndex :", lastSelectedIndex);
    if (typeof lastSelectedIndex !== 'undefined' && photos[lastSelectedIndex]) {
      showPhotoInfo(photos[lastSelectedIndex]);
      return;
    }
  }
  // Ouvrir dans l'explorateur OS
  if (e.key.toLowerCase() === 'e') {
    console.log("Touche E pressée, photo active :", photos[lastSelectedIndex], lastSelectedIndex);
    console.log("lasSelectedIndex :", lastSelectedIndex);
    if (typeof lastSelectedIndex !== 'undefined' && photos[lastSelectedIndex]) {
      revealInFileManager(photos[lastSelectedIndex]);
      return;
    }
  }
  // Copie vers
  if (e.key.toLowerCase() === 'c') {
    console.log("Touche C pressée, indice photos actives:", selectedIndices);
    if (typeof selectedIndices !== 'undefined' && selectedIndices.size > 0) {
      const selectedPhotos = commandTargetPhotos(); // mode Comparer avec plusieurs photos : sous-sélection
      if (selectedPhotos.length > 0) {
        copyPhotosTo(selectedPhotos);
        return;
      }
      if (isCompareMultiple()) {
        notifyNoCompareTarget();
        return;
      }
    }
  }
  // Redimensionner par lot (S) : sur la sélection uniquement (sous-sélection en mode Comparer avec plusieurs photos). Sans effet derrière une fenêtre
  // ouverte, avec Ctrl / Alt / ⌘ (Ctrl+S reste libre) ou en touche maintenue.
  if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && selectedIndices.size > 0) {
    if (document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault();
    if (e.repeat) return;
    const selectedPhotos = commandTargetPhotos();
    if (selectedPhotos.length > 0) {
      resizePhotos(selectedPhotos);
    } else if (isCompareMultiple()) {
      notifyNoCompareTarget();
    }
    return;
  }
  // Suppression
if (e.key === 'Delete') {
    if (typeof selectedIndices !== 'undefined' && selectedIndices.size > 0) {
      // Mode comparaison : seule la photo unique ou les photos de la sous-sélection sont visées, jamais toute la comparaison.
      const targetPhotos = commandTargetPhotos();
      if (targetPhotos.length > 0) {
        confirmAndDelete(targetPhotos);
        return;
      }
      if (isCompareMultiple()) {
        notifyNoCompareTarget();
        return;
      }
    }
  }
  // Bascule des panneaux et modes :
  // X : mode Comparer | P : aperçu | N : panneau Filtres (gauche) | J : panneau Info (droite)
  // Inactif en plein écran ou lorsqu'une fenêtre modale est ouverte.
  const panelToggleButtons = {
    x: 'btn-toggle-compare',
    p: 'btn-toggle-preview',
    n: 'btn-toggle-sidebar',
    j: 'btn-toggle-exif',
  };
  const targetToggleBtnId = panelToggleButtons[e.key.toLowerCase()];
  if (targetToggleBtnId && !e.ctrlKey && !e.metaKey && !e.altKey && !isFullscreen && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    if (!e.repeat) document.getElementById(targetToggleBtnId)?.click();
    return;
  }
  // Mode Comparer, plusieurs photos : A sous-sélectionne toutes les photos (ou aucune si elles le sont déjà)
  if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && isCompareMultiple()) {
    e.preventDefault();
    toggleAllCompareSubSelection();
    return;
  }
  // Rating shortcuts
  if (/^[0-5]$/.test(e.key) && selectedIndices.size > 0) {
    e.preventDefault();
    setSelectionRating(Number(e.key));
    return;
  }
  // Zoom (+ / - / *) : sur l'aperçu (ou l'image survolée en mode désynchronisé), ou sur l'image du plein écran quand il est ouvert
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const zoomTarget = isFullscreen ? null : hoveredPreviewSlot;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomPreviewSteps(1, null, zoomTarget); return; }
    if (e.key === '-') { e.preventDefault(); zoomPreviewSteps(-1, null, zoomTarget); return; }
    if (e.key === '*') { e.preventDefault(); togglePreviewActualSize(null, zoomTarget); return; }
  }
  // Navigation
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigatePhoto(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigatePhoto(-1);
  } else if (e.key === 'Escape') {
    if (isFullscreen && guideModal.classList.contains('hidden')) closeFullscreen(); // guide ouvert par-dessus le plein écran : Échap ne ferme que le guide
  } else if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (isFullscreen) closeFullscreen();
    else if (photos.length > 0) openFullscreen(lastSelectedIndex);
  }
});

// ==========================================
// MODALE PARAMÈTRES
// ==========================================
// GESTION DES ONGLETS DE LA MODALE PARAMÈTRES
document.querySelectorAll('.settings-tab-btn').forEach(button => {
  button.addEventListener('click', () => {
    const targetTab = button.dataset.tab;
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
      const active = btn === button;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.settings-tab-pane').forEach(pane => {
      const active = pane.id === `settings-tab-${targetTab}`;
      pane.classList.toggle('active', active);
      pane.hidden = !active;
    });
  });
});

// ==========================================
// MODALE PARAMÈTRES (Gestion des dossiers)
// ==========================================
function renderSettingsFolderList() {
  settingsFolderList.innerHTML = '';
  for (let f of folders) {
    const li = document.createElement('li');
    li.className = 'settings-folder-item';
    li.innerHTML = `
      <span title="${f.path}">${f.path}</span>
      <button class="btn-remove-folder">${t('Remove')}</button>
    `;
    li.querySelector('.btn-remove-folder').addEventListener('click', async () => {
      dropScanTasksForFolder(f.path); // un dossier retiré ne doit plus être scanné
      folders = await invoke('remove_folder', { id: f.id, path: f.path });
      if (currentFolderFilter === f.path) currentFolderFilter = null;
      renderFolderTree();
      renderSettingsFolderList();
      loadPhotos();
    });
    settingsFolderList.appendChild(li);
  }
}

document.getElementById('btn-open-settings').addEventListener('click', () => {
  refreshStorageLocationUI();
  settingsModal.classList.remove('hidden');
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

// ==========================================
// MODALE À PROPOS (ouverte depuis les Paramètres)
// ==========================================
const aboutModal = document.getElementById('about-modal');
const aboutVersion = document.getElementById('about-version');
async function openAbout() {
  aboutModal.classList.remove('hidden');
  if (aboutVersion.dataset.loaded) return;
  try {
    aboutVersion.textContent = await getVersion();
    aboutVersion.dataset.loaded = 'true';
  } catch (error) {
    console.error('Version indisponible', error);
  }
}
function closeAbout() {
  aboutModal.classList.add('hidden');
}
document.getElementById('btn-open-about').addEventListener('click', openAbout);
document.getElementById('btn-close-about').addEventListener('click', closeAbout);

document.getElementById('about-github-link').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
        await openUrl('https://github.com/alexh3o/photoboggan');
    } catch (err) {
        console.error("Impossible d'ouvrir le lien :", err);
    }
});
document.getElementById('about-issues-link')?.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await openUrl('https://github.com/alexh3o/photoboggan/issues');
  } catch (err) {
    console.error("Impossible d'ouvrir le lien :", err);
  }
});

// ESC ferme la fenêtre la plus haute (À propos, puis Paramètres), même si un champ des paramètres a le focus.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!aboutModal.classList.contains('hidden')) {
    event.preventDefault();
    closeAbout();
  } else if (!settingsModal.classList.contains('hidden')) {
    event.preventDefault();
    settingsModal.classList.add('hidden');
  }
});


// ==========================================
// MODALE Guide (ouverte depuis les Paramètres)
// ==========================================
const guideModal = document.getElementById('guide-modal');
const guideVersion = document.getElementById('guide-version');
async function openGuide() {
  guideModal.classList.remove('hidden');
  if (guideVersion.dataset.loaded) return;
  try {
    guideVersion.textContent = await getVersion();
    guideVersion.dataset.loaded = 'true';
  } catch (error) {
    console.error('Version indisponible', error);
  }
}
function closeGuide() {
  guideModal.classList.add('hidden');
}
document.getElementById('btn-open-guide').addEventListener('click', openGuide);
document.getElementById('btn-close-guide').addEventListener('click', closeGuide);



// ESC ferme la fenêtre la plus haute (À propos, puis Paramètres), même si un champ des paramètres a le focus.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!guideModal.classList.contains('hidden')) {
    event.preventDefault();
    closeGuide();
  } else if (!settingsModal.classList.contains('hidden')) {
    event.preventDefault();
    settingsModal.classList.add('hidden');
  }
});


document.getElementById('btn-add-folder').addEventListener('click', async () => {
  const dir = await open({ directory: true });
  if (dir) {

    // Le dossier est ajouté tout de suite à la liste (arborescence et Paramètres) ; son scan passe par la file d'attente des tâches.
    try {
      folders = await invoke('add_folder', { path: dir });
      renderFolderTree();
      renderSettingsFolderList();
    } catch (error) {
      console.error('Ajout de dossier impossible', error);
      showWriteToast(t('Unable to read metadata: {error}', { error }));
      return;
    }
    enqueueScanTask({ kind: 'add', path: dir, command: 'scan_folder', args: { path: dir }, labelKey: 'Scanning folder {folder}…', labelParams: { folder: folderBaseName(dir) } });
  }
});

// ==========================================
// BOUTONS VUES & SIDEBAR
// ==========================================
document.getElementById('btn-toggle-sidebar').addEventListener('click', event => {
  const sidebarVisible = sidebarPanel.classList.toggle('hidden') === false;
  event.currentTarget.classList.toggle('active', sidebarVisible);
  localStorage.setItem('sidebarVisible', String(sidebarVisible)); // Mémorisation de l'état

  if (sidebarVisible) {
    if (sidebarWidth > 0) sidebarPanel.style.width = `${sidebarWidth}px`;
  } else {
    sidebarPanel.style.removeProperty('width');
  }

  setTimeout(updateVirtualScroller, 300);
});


// ==========================================
// REDIMENSIONNEMENT DU PANNEAU LATÉRAL GAUCHE
// ==========================================
const sidebarResizer = document.getElementById('sidebar-resizer');
let sidebarWidth = Number(localStorage.getItem('sidebarWidth')) || 0;
if (sidebarWidth > 0) {
  sidebarPanel.style.width = `${sidebarWidth}px`;
}

sidebarResizer?.addEventListener('pointerdown', event => {
  if (sidebarPanel.classList.contains('hidden')) return;
  sidebarResizer.setPointerCapture(event.pointerId);
  sidebarResizer.classList.add('dragging');
  sidebarPanel.classList.add('resizing');
  let resizeFrame = null;
  let latestPointerEvent = event;

  const resize = pointerEvent => {
    latestPointerEvent = pointerEvent;
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const mainLeft = mainContent.getBoundingClientRect().left;
      const minSidebarWidth = 175; // ~11rem
      const maxSidebarWidth = Math.max(minSidebarWidth, mainContent.clientWidth - 300);
      const newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, latestPointerEvent.clientX - mainLeft));
      sidebarPanel.style.width = `${newWidth}px`;
      sidebarWidth = newWidth;
      updateVirtualScroller();
    });
  };

  const stop = event => {
    if (Number.isFinite(event?.clientX)) latestPointerEvent = event;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    if (Number.isFinite(latestPointerEvent.clientX)) {
      const mainLeft = mainContent.getBoundingClientRect().left;
      const minSidebarWidth = 175;
      const maxSidebarWidth = Math.max(minSidebarWidth, mainContent.clientWidth - 300);
      const newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, latestPointerEvent.clientX - mainLeft));
      sidebarPanel.style.width = `${newWidth}px`;
      sidebarWidth = newWidth;
      localStorage.setItem('sidebarWidth', String(newWidth));
    }
    sidebarResizer.classList.remove('dragging');
    sidebarPanel.classList.remove('resizing');
    sidebarResizer.removeEventListener('pointermove', resize);
    sidebarResizer.removeEventListener('pointerup', stop);
    sidebarResizer.removeEventListener('pointercancel', stop);
    updateVirtualScroller();
  };

  sidebarResizer.addEventListener('pointermove', resize);
  sidebarResizer.addEventListener('pointerup', stop);
  sidebarResizer.addEventListener('pointercancel', stop);
});

// Accessibilité clavier (flèches gauche / droite sur la poignée)
sidebarResizer?.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const currentWidth = sidebarPanel.getBoundingClientRect().width;
  const change = event.key === 'ArrowRight' ? 20 : -20;
  const minSidebarWidth = 175;
  const maxSidebarWidth = Math.max(minSidebarWidth, mainContent.clientWidth - 300);
  const newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, currentWidth + change));
  sidebarPanel.style.width = `${newWidth}px`;
  sidebarWidth = newWidth;
  localStorage.setItem('sidebarWidth', String(newWidth));
  updateVirtualScroller();
});

const previewResizer = document.getElementById('preview-resizer');
const mainContent = document.querySelector('.main-content');
document.getElementById('btn-toggle-preview').addEventListener('click', event => {
  const visible = mainContent.classList.toggle('preview-hidden') === false;
  event.currentTarget.classList.toggle('active', visible);
  localStorage.setItem('previewVisible', String(visible)); // Mémorisation
  requestAnimationFrame(updateVirtualScroller);
});
document.getElementById('thumbnail-layout').value = thumbnailLayout;
document.getElementById('thumbnail-layout').addEventListener('change', event => {
  thumbnailLayout = event.target.value;
  localStorage.setItem('thumbnailLayout', thumbnailLayout);
  updateVirtualScroller();
});
// ==========================================
// TRI DES MINIATURES
// ==========================================
// Le tri s'applique à la liste affichée (photos, voir applyPhotoFilters) : il détermine donc à la fois l'ordre de la grille et celui du
// défilement en plein écran. Il est fait côté interface : la date de modification vient de la base, la date de prise de vue est celle du filtre de date.
const sortModal = document.getElementById('sort-modal');
const sortButton = document.getElementById('btn-open-sort');
const SORT_KEY_LABELS = { taken: 'Date taken', modified: 'Date modified', name: 'Filename' };
const sortNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); // « IMG_2 » avant « IMG_10 », comme l'Explorateur

// Valeur de tri d'une photo ; null = information absente (ces photos restent en fin de liste, quel que soit l'ordre).
function photoSortValue(photo) {
  if (sortKey === 'name') return photo.filename || photo.path.split(/[\\/]/).pop() || '';
  if (sortKey === 'modified') return photo.modified > 0 ? photo.modified : null;
  return photoTimeKey(photo);
}

// Séparateur actif selon le critère de tri : 'none', 'day', 'week', 'month', 'year' (tri par date) ou 'folder' (tri par nom de fichier).
function activeSeparator() {
  return sortKey === 'name' ? nameSeparator : dateSeparator;
}

// Dossier d'une photo (chemin sans le nom de fichier) et ses segments, calculés une fois pour le tri et le regroupement.
function photoFolder(photo) {
  if (photo.folderPath === undefined) {
    const cut = Math.max(photo.path.lastIndexOf('\\'), photo.path.lastIndexOf('/'));
    photo.folderPath = cut >= 0 ? photo.path.slice(0, cut) : '';
    photo.folderSegments = photo.folderPath.split(/[\\/]+/).filter(Boolean);
  }
  return photo.folderPath;
}

// Compare les dossiers segment par segment (le dossier parent passe avant ses sous-dossiers), avec le même ordre naturel que les noms de fichiers.
function compareFolders(a, b) {
  photoFolder(a);
  photoFolder(b);
  const segmentsA = a.folderSegments;
  const segmentsB = b.folderSegments;
  const shared = Math.min(segmentsA.length, segmentsB.length);
  for (let i = 0; i < shared; i++) {
    const result = sortNameCollator.compare(segmentsA[i], segmentsB[i]);
    if (result) return result;
  }
  if (segmentsA.length !== segmentsB.length) return segmentsA.length - segmentsB.length;
  return a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : 0;
}

// Jour de la photo pour le critère de tri par date (prise de vue ou modification), ou null si la date est absente ou invalide.
function photoSortDateParts(photo) {
  let dayKey;
  if (sortKey === 'modified') {
    if (!(photo.modified > 0)) return null;
    const date = new Date(photo.modified);
    dayKey = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  } else {
    dayKey = photoDateKey(photo);
  }
  if (dayKey === null || !isValidDateKey(dayKey)) return null;
  return { year: Math.floor(dayKey / 10000), month: Math.floor(dayKey / 100) % 100, day: dayKey % 100 };
}

// Semaine ISO 8601 (du lundi au dimanche, la semaine 1 contient le 4 janvier) : année ISO et numéro de semaine.
function isoWeekOf({ year, month, day }) {
  const target = new Date(Date.UTC(year, month - 1, day));
  target.setUTCDate(target.getUTCDate() - ((target.getUTCDay() + 6) % 7) + 3); // jeudi de la même semaine
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return { isoYear, week: 1 + Math.round((target - firstThursday) / (7 * 86400000)) };
}

// Identifiant du groupe d'une photo : deux photos voisines (la liste est déjà triée) de même identifiant sont dans le même groupe.
function separatorGroupKey(photo, mode) {
  if (mode === 'folder') {
    photoFolder(photo);
    return photo.folderSegments.join('/').toLowerCase(); // les chemins Windows ne distinguent pas les majuscules
  }
  const parts = photoSortDateParts(photo);
  if (!parts) return 'unknown';
  if (mode === 'year') return String(parts.year);
  if (mode === 'month') return `${parts.year}-${parts.month}`;
  if (mode === 'week') {
    const { isoYear, week } = isoWeekOf(parts);
    return `${isoYear}-W${week}`;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Texte de la ligne de séparation d'un groupe, d'après sa première photo ; title = infobulle (chemin complet pour un dossier).
function separatorText(photo, mode) {
  if (mode === 'folder') {
    photoFolder(photo);
    return { label: photo.folderPath || '…', title: photo.folderPath };
  }
  const parts = photoSortDateParts(photo);
  if (!parts) return { label: t('Unknown date'), title: '' };
  const language = getLanguage();
  const date = new Date(parts.year, parts.month - 1, parts.day);
  let label;
  if (mode === 'year') {
    label = String(parts.year);
  } else if (mode === 'month') {
    label = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(date);
  } else if (mode === 'week') {
    const monday = new Date(parts.year, parts.month - 1, parts.day - ((date.getDay() + 6) % 7));
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const range = new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(monday, sunday);
    label = `${t('Week {week}', { week: isoWeekOf(parts).week })} · ${range}`;
  } else {
    label = new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }
  return { label: label.charAt(0).toLocaleUpperCase(language) + label.slice(1), title: '' };
}

// Découpe la liste affichée en groupes consécutifs [start, end[ selon le séparateur actif ; liste vide = pas de séparateur.
function computePhotoGroups() {
  const mode = activeSeparator();
  if (mode === 'none' || photos.length === 0) return [];
  const groups = [];
  let current = null;
  let currentKey = null;
  for (let i = 0; i < photos.length; i++) {
    const key = separatorGroupKey(photos[i], mode);
    if (current && key === currentKey) continue;
    if (current) current.end = i;
    current = { start: i, end: photos.length, ...separatorText(photos[i], mode) };
    currentKey = key;
    groups.push(current);
  }
  return groups;
}

function comparePhotosForSort(a, b) {
  // Tri par nom avec séparateur par dossier : les dossiers d'abord (dans le sens choisi), puis les noms au sein de chaque dossier.
  if (activeSeparator() === 'folder') {
    const folderResult = compareFolders(a, b);
    if (folderResult) return sortOrder === 'asc' ? folderResult : -folderResult;
  }
  const valueA = photoSortValue(a);
  const valueB = photoSortValue(b);
  if (valueA === null || valueB === null) {
    if (valueA !== valueB) return valueA === null ? 1 : -1;
  } else {
    const result = sortKey === 'name' ? sortNameCollator.compare(valueA, valueB) : valueA - valueB;
    if (result) return sortOrder === 'asc' ? result : -result;
  }
  // Égalité (rafale prise dans la même seconde, valeurs absentes…) : ordre stable et prévisible, indépendant du sens choisi.
  return sortNameCollator.compare(a.filename || '', b.filename || '') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function sortOrderHint(key, order) {
  if (key === 'name') return order === 'asc' ? 'A → Z' : 'Z → A';
  return t(order === 'asc' ? 'Oldest first' : 'Newest first');
}

// Boutons radio de la modale, aides de l'ordre selon le critère, et infobulle du bouton de la barre du haut (ordre actif au survol).
function updateSortUI() {
  sortModal.querySelectorAll('input[name="sort-key"]').forEach(input => { input.checked = input.value === sortKey; });
  sortModal.querySelectorAll('input[name="sort-order"]').forEach(input => { input.checked = input.value === sortOrder; });
  sortModal.querySelectorAll('input[name="sort-separator-date"]').forEach(input => { input.checked = input.value === dateSeparator; });
  sortModal.querySelectorAll('input[name="sort-separator-name"]').forEach(input => { input.checked = input.value === nameSeparator; });
  document.getElementById('sort-separator-date').hidden = sortKey === 'name'; // les séparateurs proposés dépendent du critère de tri
  document.getElementById('sort-separator-name').hidden = sortKey !== 'name';
  document.getElementById('sort-separator-name-note').hidden = nameSeparator !== 'folder';
  document.getElementById('sort-hint-asc').textContent = `(${sortOrderHint(sortKey, 'asc')})`;
  document.getElementById('sort-hint-desc').textContent = `(${sortOrderHint(sortKey, 'desc')})`;
  const order = `${t(sortOrder === 'asc' ? 'Ascending' : 'Descending')} (${sortOrderHint(sortKey, sortOrder)})`;
  const description = `${labelWithColon('Sort')} ${t(SORT_KEY_LABELS[sortKey])} · ${order}`;
  sortButton.title = description;
  sortButton.setAttribute('aria-label', description);
}

// Amène la photo dans la zone visible si elle n'y est pas : après un changement de tri, la photo sélectionnée a changé de place.
function scrollToPhotoIndex(index) {
  const layout = photoLayouts.find(item => item.index === index);
  if (!layout) return;
  const viewTop = gridContainer.scrollTop;
  const viewBottom = viewTop + gridContainer.clientHeight;
  if (layout.y >= viewTop && layout.y + layout.height <= viewBottom) return;
  gridContainer.scrollTop = Math.max(0, layout.y - (gridContainer.clientHeight - layout.height) / 2);
  renderVisibleItems();
}

function applySortChange() {
  localStorage.setItem('photoSortKey', sortKey);
  localStorage.setItem('photoSortOrder', sortOrder);
  localStorage.setItem('photoDateSeparator', dateSeparator);
  localStorage.setItem('photoNameSeparator', nameSeparator);
  updateSortUI();
  fullscreenImageCache.clear(); // le cache de préchargement est indexé par position dans la liste
  applyPhotoFilters({ keepState: true }); // sélection conservée (retrouvée par chemin)
  scrollToPhotoIndex(lastSelectedIndex);
}

function openSortModal() {
  sortModal.classList.remove('hidden');
  // Le focus sur un champ de la modale évite que les raccourcis clavier (SUPPR, C…) visent la grille pendant qu'elle est ouverte.
  sortModal.querySelector('input[name="sort-key"]:checked')?.focus();
}

function closeSortModal() {
  sortModal.classList.add('hidden');
}

sortButton.addEventListener('click', openSortModal);
document.getElementById('btn-close-sort').addEventListener('click', closeSortModal);
sortModal.addEventListener('click', event => { if (event.target === sortModal) closeSortModal(); });
sortModal.addEventListener('change', event => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.name === 'sort-key' && SORT_KEYS.includes(input.value)) sortKey = input.value;
  else if (input.name === 'sort-order') sortOrder = input.value === 'asc' ? 'asc' : 'desc';
  else if (input.name === 'sort-separator-date' && DATE_SEPARATORS.includes(input.value)) dateSeparator = input.value;
  else if (input.name === 'sort-separator-name' && NAME_SEPARATORS.includes(input.value)) nameSeparator = input.value;
  else return;
  applySortChange();
});
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || sortModal.classList.contains('hidden')) return;
  event.preventDefault();
  closeSortModal();
});
updateSortUI();

const themeSelect = document.getElementById('theme-select');
const selectionColorInput = document.getElementById('accent-color');
const selectionColorSwatches = document.querySelectorAll('.accent-swatch');
const activeButtonColorInput = document.getElementById('active-button-color');
const activeButtonColorSwatches = document.querySelectorAll('.button-swatch');
function syncAppearanceControls() {
  themeSelect.value = appTheme;
  selectionColorInput.value = selectionColor;
  selectionColorSwatches.forEach(swatch => swatch.classList.toggle('active', swatch.dataset.color.toLowerCase() === selectionColor.toLowerCase()));
  activeButtonColorInput.value = activeButtonColor;
  activeButtonColorSwatches.forEach(swatch => swatch.classList.toggle('active', swatch.dataset.color.toLowerCase() === activeButtonColor.toLowerCase()));
}
function setActiveButtonColor(color) {
  activeButtonColor = color;
  localStorage.setItem('activeButtonColor', color);
  applyAppearance();
  syncAppearanceControls();
}
function setSelectionColor(color) {
  selectionColor = color;
  localStorage.setItem('selectionColor', color);
  applyAppearance();
  syncAppearanceControls();
}
themeSelect.addEventListener('change', event => {
  appTheme = event.target.value === 'light' ? 'light' : 'dark';
  localStorage.setItem('appTheme', appTheme);
  applyAppearance();
});
selectionColorInput.addEventListener('input', event => setSelectionColor(event.target.value));
selectionColorSwatches.forEach(swatch => swatch.addEventListener('click', () => setSelectionColor(swatch.dataset.color)));
activeButtonColorInput.addEventListener('input', event => setActiveButtonColor(event.target.value));
activeButtonColorSwatches.forEach(swatch => swatch.addEventListener('click', () => setActiveButtonColor(swatch.dataset.color)));
syncAppearanceControls();

// LANGUE (mémorisée localement) : le français est la langue par défaut.
const languageSelect = document.getElementById('language-select');
languageSelect.replaceChildren(...Object.entries(LANGUAGES).map(([code, { label }]) => new Option(label, code)));
languageSelect.value = getLanguage();
languageSelect.addEventListener('change', event => setLanguage(event.target.value));
applyTranslations();
// Textes construits en JavaScript : régénérés quand la langue change (les éléments data-i18n le sont par applyTranslations).
onLanguageChange(() => {
  renderFolderTree();
  renderSettingsFolderList();
  renderKeywordFilters();
  updateUIOnSelection();
  updateRatingAction();
  updateFilteredPhotosCount();
  renderFilterSummaries(); // résumés des filtres dans la langue courante (dates, infobulles, étiquettes)
  updateDateFilterUI(parseDateFilter(dateFilterInput.value).error);
  updateSortUI();
  updateVirtualScroller(); // libellés des séparateurs (jours, mois…) dans la nouvelle langue
  datePicker.setAttribute('aria-label', t('Choose a date or a range'));
  if (isDatePickerOpen()) {
    renderDatePicker();
    positionDatePicker();
  }
});

const thumbnailSizeInput = document.getElementById('thumbnail-size');
const thumbnailSizeValue = document.getElementById('thumbnail-size-value');
thumbnailSizeInput.max = String(thumbnailCacheSize); // Valeur max synchronisée
thumbnailSizeInput.value = String(thumbnailSize);
thumbnailSizeValue.textContent = `${thumbnailSize} px`;

thumbnailSizeInput.addEventListener('input', event => {
  thumbnailSizeValue.textContent = `${event.target.value} px`;
});
thumbnailSizeInput.addEventListener('change', event => {
  thumbnailSize = Number(event.target.value);
  localStorage.setItem('thumbnailSize', String(thumbnailSize));
  requestAnimationFrame(updateVirtualScroller);
});
// Gestionnaire du sélecteur de taille des miniatures en cache
const thumbnailCacheSelect = document.getElementById('thumbnail-cache-size-select');
if (thumbnailCacheSelect) {
  thumbnailCacheSelect.value = String(thumbnailCacheSize);
  thumbnailCacheSelect.addEventListener('change', async (e) => {
    const newSize = Number(e.target.value);
    if (newSize === thumbnailCacheSize) return;

    const confirmed = await confirmDialog({
      title: t('Thumbnail cache size'),
      message: t('Change thumbnail cache size? This will delete all thumbnails, they will be gradually rebuilt during navigation.'),
      confirmLabel: t('Change'),
      cancelLabel: t('Cancel'),
    });

    if (!confirmed) {
      thumbnailCacheSelect.value = String(thumbnailCacheSize);
      return;
    }

    showTaskToast(t('Thumbnails cache cleared'), 0);
    try {
      await invoke('clear_thumbnail_cache');
      await invoke('set_thumbnail_cache_size', { size: newSize });
      thumbnailCacheSize = newSize;
      localStorage.setItem('thumbnailCacheSize', String(thumbnailCacheSize));

      // Met à jour la borne max de la modale "Options d'affichage"
      thumbnailSizeInput.max = String(thumbnailCacheSize);
      if (thumbnailSize > thumbnailCacheSize) {
        thumbnailSize = thumbnailCacheSize;
        localStorage.setItem('thumbnailSize', String(thumbnailSize));
        thumbnailSizeInput.value = String(thumbnailSize);
        thumbnailSizeValue.textContent = `${thumbnailSize} px`;
      }

      // Vide les caches mémoire du frontend
      thumbnailCacheLookups.clear();
      thumbnailCacheWrites.clear();
      pendingThumbnailLookups.clear();
      for (const node of renderedThumbnailNodes.values()) node.remove();
      renderedThumbnailNodes.clear();

      updateVirtualScroller();
      showWriteToast(t('Thumbnails cache cleared'));
    } catch (err) {
      console.error('Erreur lors du changement de taille du cache', err);
      thumbnailCacheSelect.value = String(thumbnailCacheSize);
    } finally {
      hideTaskToast();
    }
  });
}
previewResizer.addEventListener('pointerdown', event => {
  if (mainContent.classList.contains('preview-hidden')) return;
  previewResizer.setPointerCapture(event.pointerId);
  previewResizer.classList.add('dragging');
  let resizeFrame = null;
  let latestPointerEvent = event;
  const resize = pointerEvent => {
    latestPointerEvent = pointerEvent;
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const gridBounds = gridContainer.getBoundingClientRect();
      const mainWidth = mainContent.clientWidth;
      const fixedWidth = sidebarPanel.getBoundingClientRect().width
        + document.getElementById('exif-panel').getBoundingClientRect().width
        + previewResizer.getBoundingClientRect().width
        + (sidebarResizer && !sidebarPanel.classList.contains('hidden') ? sidebarResizer.getBoundingClientRect().width : 0);
      const maxGridWidth = Math.max(160, mainWidth - fixedWidth - 160);
      const gridWidth = Math.max(160, Math.min(maxGridWidth, latestPointerEvent.clientX - gridBounds.left));
      mainContent.style.setProperty('--grid-width', `${gridWidth}px`);
      mainContent.classList.add('split-custom');
    });
  };
  const stop = event => {
    if (Number.isFinite(event?.clientX)) latestPointerEvent = event;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    if (Number.isFinite(latestPointerEvent.clientX)) {
      const gridBounds = gridContainer.getBoundingClientRect();
      const mainWidth = mainContent.clientWidth;
      const fixedWidth = sidebarPanel.getBoundingClientRect().width
        + document.getElementById('exif-panel').getBoundingClientRect().width
        + previewResizer.getBoundingClientRect().width
        + (sidebarResizer && !sidebarPanel.classList.contains('hidden') ? sidebarResizer.getBoundingClientRect().width : 0);
      const maxGridWidth = Math.max(160, mainWidth - fixedWidth - 160);
      const gridWidth = Math.max(160, Math.min(maxGridWidth, latestPointerEvent.clientX - gridBounds.left));
      mainContent.style.setProperty('--grid-width', `${gridWidth}px`);
      mainContent.classList.add('split-custom');
    }
    previewResizer.classList.remove('dragging');
    previewResizer.removeEventListener('pointermove', resize);
    previewResizer.removeEventListener('pointerup', stop);
    previewResizer.removeEventListener('pointercancel', stop);
    updateVirtualScroller();
  };
  previewResizer.addEventListener('pointermove', resize);
  previewResizer.addEventListener('pointerup', stop);
  previewResizer.addEventListener('pointercancel', stop);
});
previewResizer.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const fixedWidth = sidebarPanel.getBoundingClientRect().width
        + document.getElementById('exif-panel').getBoundingClientRect().width
        + previewResizer.getBoundingClientRect().width
        + (sidebarResizer && !sidebarPanel.classList.contains('hidden') ? sidebarResizer.getBoundingClientRect().width : 0);
  const maxGridWidth = Math.max(160, mainContent.clientWidth - fixedWidth - 160);
  const change = event.key === 'ArrowRight' ? 20 : -20;
  const width = Math.max(160, Math.min(maxGridWidth, gridContainer.clientWidth + change));
  mainContent.style.setProperty('--grid-width', `${width}px`);
  mainContent.classList.add('split-custom');
  updateVirtualScroller();
});

document.getElementById('btn-toggle-exif').addEventListener('click', event => {
  const exifVisible = document.getElementById('exif-panel').classList.toggle('hidden') === false;
  event.currentTarget.classList.toggle('active', exifVisible);
  localStorage.setItem('exifVisible', String(exifVisible)); // Memorisation
  setTimeout(updateVirtualScroller, 300);
});

document.getElementById('rating-filter').addEventListener('change', applyPhotoFilters);

// Filtre par couleur : plusieurs carrés peuvent être cochés (une photo est affichée si elle a l'une des couleurs cochées).
const colorFilterBar = document.getElementById('color-filter-bar');
colorFilterBar.replaceChildren(...COLOR_FLAGS.map(createColorSquare));
colorFilterBar.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('.color-square') : null;
  if (!button) return;
  const key = button.dataset.flag;
  if (colorFilters.has(key)) colorFilters.delete(key); else colorFilters.add(key);
  setColorSquareChecked(button, colorFilters.has(key));
  applyPhotoFilters();
});

// Écriture de la couleur sur la sélection : une seule couleur, un nouveau clic sur la couleur active l'efface.
const selectionColorBar = document.getElementById('selection-color-flags');
selectionColorBar.replaceChildren(...COLOR_FLAGS.map(createColorSquare));
selectionColorBar.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('.color-square') : null;
  if (button) setSelectionColorFlag(button.dataset.flag);
});
document.getElementById('keyword-filter-input').addEventListener('change', event => addKeywordFilter(event.target.value));
document.getElementById('keyword-filter-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); addKeywordFilter(event.target.value); }
});
document.getElementById('filename-filter-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); addFilenameFilter(event.target.value); }
});
document.getElementById('recursive-folder-toggle').checked = includeSubfolders;
document.getElementById('recursive-folder-toggle').addEventListener('change', event => {
  includeSubfolders = event.target.checked;
  localStorage.setItem('includeSubfolders', String(includeSubfolders));
  loadPhotos();
});
document.querySelectorAll('#selection-rating-stars button').forEach(button => {
  button.addEventListener('click', () => setSelectionRating(Number(button.dataset.rating)));
});
// ==========================================
// FILE D'ATTENTE DES TÂCHES (scan d'un dossier ajouté, relecture de la collection ou d'un dossier)
// ==========================================
// Une seule tâche de scan s'exécute à la fois, les autres attendent leur tour dans l'ordre de leur demande. Chaque tâche a son toast (la tâche en cours en bas,
// avec son avancement ; les suivantes au-dessus, « En attente ») et sa ligne dans la fenêtre « Actions en cours » (bouton sablier de la barre du haut), qui permet
// d'arrêter la tâche en cours ou de retirer une tâche en attente. Le backend publie l'avancement dans « scan-progress » avec l'identifiant de la tâche.
// { id, kind: 'add' | 'rescan-all' | 'rescan-folder', path (null = toute la collection), command, args, labelKey, labelParams,
//   status: 'waiting' | 'running', percent, stopRequested, toastHidden }
const scanTasks = [];
let scanTaskCounter = 0;
let scanPumpActive = false;
let transientToast = null; // toast d'une opération courte qui n'est pas un scan (déplacement des données, cache des miniatures) : showTaskToast / hideTaskToast
const taskToastsContainer = document.getElementById('task-toasts');
const tasksButton = document.getElementById('btn-open-tasks');
const tasksModal = document.getElementById('tasks-modal');
const tasksList = document.getElementById('tasks-list');
const taskToastElements = new Map(); // tâche -> son toast
const taskRowElements = new Map(); // tâche -> sa ligne dans la fenêtre des actions

const folderBaseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
const normalizeTaskPath = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const taskName = task => task.displayName ?? t(task.labelKey, task.labelParams);
const taskPercent = task => Math.max(0, Math.min(100, Math.round(task.percent)));

function taskStatusText(task) {
  if (task.status === 'waiting') return t('Waiting');
  if (task.stopRequested) return t('Stopping…');
  return `${taskPercent(task)} %`;
}

// Une tâche couvre un dossier quand c'est le sien, l'un de ses sous-dossiers, ou que la tâche relit toute la collection.
function taskCoversFolder(task, path) {
  if (task.path === null) return true;
  const root = normalizeTaskPath(task.path);
  const folder = normalizeTaskPath(path);
  return folder === root || folder.startsWith(`${root}/`);
}

// Place les éléments dans l'ordre voulu sans toucher à ceux qui y sont déjà (un bouton déplacé pendant un clic perdrait ce clic).
function syncChildren(container, wanted) {
  for (const child of [...container.children]) if (!wanted.includes(child)) child.remove();
  wanted.forEach((element, position) => {
    if (container.children[position] !== element) container.insertBefore(element, container.children[position] || null);
  });
}

function buildTaskToast(task) {
  const toast = document.createElement('div');
  toast.className = 'task-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'task-toast-text';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'task-toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => {
    task.toastHidden = true; // le toast se ferme, la tâche continue (elle reste dans la fenêtre des actions)
    syncTaskUI();
  });
  toast.append(text, close);
  return toast;
}

function buildTaskRow(task) {
  const row = document.createElement('li');
  row.className = 'task-item';
  const name = document.createElement('span');
  name.className = 'task-item-name';
  const status = document.createElement('span');
  status.className = 'task-item-status';
  const bar = document.createElement('div');
  bar.className = 'task-item-bar';
  bar.append(document.createElement('span'));
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'task-item-action';
  action.addEventListener('click', () => removeOrStopTask(task));
  row.append(name, status, bar, action);
  return row;
}

// Met l'affichage en phase avec les tâches : toasts, lignes de la fenêtre des actions et bouton sablier.
function syncTaskUI() {
  const toastTasks = [...scanTasks, ...(transientToast ? [transientToast] : [])].filter(task => !task.toastHidden);
  const toasts = toastTasks.map(task => {
    let toast = taskToastElements.get(task);
    if (!toast) {
      toast = buildTaskToast(task);
      taskToastElements.set(task, toast);
    }
    toast.classList.toggle('waiting', task.status === 'waiting');
    toast.querySelector('.task-toast-text').textContent = `${taskName(task)} · ${taskStatusText(task)}`;
    const close = toast.querySelector('.task-toast-close');
    close.title = t('Close');
    close.setAttribute('aria-label', t('Close'));
    return toast;
  });
  for (const [task, toast] of taskToastElements) {
    if (!toastTasks.includes(task)) {
      toast.remove();
      taskToastElements.delete(task);
    }
  }
  syncChildren(taskToastsContainer, toasts);

  const rows = scanTasks.map(task => {
    let row = taskRowElements.get(task);
    if (!row) {
      row = buildTaskRow(task);
      taskRowElements.set(task, row);
    }
    row.classList.toggle('waiting', task.status === 'waiting');
    const name = row.querySelector('.task-item-name');
    name.textContent = taskName(task);
    name.title = taskName(task);
    row.querySelector('.task-item-status').textContent = taskStatusText(task);
    row.querySelector('.task-item-bar > span').style.width = `${task.status === 'waiting' ? 0 : taskPercent(task)}%`;
    const action = row.querySelector('.task-item-action');
    action.textContent = task.status === 'waiting' ? t('Remove from queue') : t('Stop');
    action.disabled = task.stopRequested;
    return row;
  });
  for (const [task, row] of taskRowElements) {
    if (!scanTasks.includes(task)) {
      row.remove();
      taskRowElements.delete(task);
    }
  }
  syncChildren(tasksList, rows);

  const label = `${t('Running tasks')} (${scanTasks.length})`;
  tasksButton.hidden = scanTasks.length === 0;
  tasksButton.title = label;
  tasksButton.setAttribute('aria-label', label);
}
onLanguageChange(syncTaskUI);

// Toast d'une opération courte hors scan (déplacement des données, vidage du cache) : un seul à la fois, affiché avec son pourcentage.
function showTaskToast(name, percent) {
  if (transientToast) {
    transientToast.displayName = name;
    transientToast.percent = percent;
  } else {
    transientToast = { displayName: name, percent, status: 'running', stopRequested: false, toastHidden: false };
  }
  syncTaskUI();
}

function hideTaskToast() {
  transientToast = null;
  syncTaskUI();
}

function openTasksModal() {
  syncTaskUI();
  tasksModal.classList.remove('hidden');
}
function closeTasksModal() {
  tasksModal.classList.add('hidden');
}
tasksButton.addEventListener('click', openTasksModal);
document.getElementById('btn-close-tasks').addEventListener('click', closeTasksModal);
tasksModal.addEventListener('click', event => {
  if (event.target === tasksModal) closeTasksModal();
});
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || tasksModal.classList.contains('hidden')) return;
  event.preventDefault();
  closeTasksModal();
});

// Avancement des tâches de scan (pourcentage de la tâche, jamais en recul si deux événements arrivent dans le désordre).
listenToBackend('scan-progress', event => {
  const { taskId, percent } = event.payload || {};
  const task = scanTasks.find(item => item.id === taskId);
  if (!task || task.status !== 'running') return;
  task.percent = Math.max(task.percent, Number(percent) || 0);
  syncTaskUI();
}).catch(error => console.debug('Suivi de la progression indisponible', error));

// Recharge les photos après un rescan. L'arborescence est construite depuis la liste complète de la collection : quand un dossier est
// filtré, cette liste est relue aussi, sinon un sous-dossier découvert par le rescan n'y apparaîtrait pas.
async function reloadPhotosAfterRescan() {
  if (currentFolderFilter !== null) {
    folderTreePhotos = await invoke('get_photos_paginated', { offset: 0, limit: 50000, folderFilter: null, recursive: includeSubfolders });
  }
  await loadPhotos();
}

// Retire une tâche en attente de la file, ou demande l'arrêt de la tâche en cours (les photos déjà lues restent dans le catalogue ;
// les fichiers non lus d'un dossier sont repris par la synchronisation avec le disque, ou par une nouvelle relecture).
function removeOrStopTask(task) {
  if (task.status === 'waiting') {
    const position = scanTasks.indexOf(task);
    if (position >= 0) scanTasks.splice(position, 1);
    syncTaskUI();
  } else if (!task.stopRequested) {
    task.stopRequested = true;
    syncTaskUI();
    invoke('cancel_scan', { taskId: task.id }).catch(error => console.debug('Arrêt du scan impossible', error));
  }
}

// Un dossier retiré de la liste des dossiers suivis ne doit plus être scanné : ses tâches en attente sont retirées, celle en cours est arrêtée.
function dropScanTasksForFolder(path) {
  for (const task of [...scanTasks]) {
    if (task.path !== null && taskCoversFolder({ path }, task.path)) removeOrStopTask(task);
  }
}

// Met une tâche en file d'attente ; elle démarre tout de suite si rien ne tourne. Elle est refusée, avec un message, quand une tâche en cours ou en attente
// couvre déjà ce dossier (même dossier, dossier parent, ou relecture de toute la collection). Renvoie true si la tâche est en file.
function enqueueScanTask({ kind, path, command, args, labelKey, labelParams }) {
  const covering = path === null
    ? scanTasks.find(task => task.path === null && !task.stopRequested)
    : scanTasks.find(task => !task.stopRequested && taskCoversFolder(task, path));
  if (covering) {
    showWriteToast(t('Already part of a scan in progress or waiting: {name}', { name: taskName(covering) }));
    return false;
  }
  scanTaskCounter += 1;
  scanTasks.push({
    id: `scan-${Date.now()}-${scanTaskCounter}`,
    kind, path, command, args, labelKey, labelParams,
    status: 'waiting', percent: 0, stopRequested: false, toastHidden: false,
  });
  syncTaskUI();
  pumpScanQueue();
  return true;
}

// Exécute les tâches une par une, dans l'ordre de la file.
async function pumpScanQueue() {
  if (scanPumpActive) return;
  scanPumpActive = true;
  try {
    for (let task = scanTasks.find(item => item.status === 'waiting'); task; task = scanTasks.find(item => item.status === 'waiting')) {
      await runScanTask(task);
    }
  } finally {
    scanPumpActive = false;
  }
}

async function runScanTask(task) {
  task.status = 'running';
  syncTaskUI();
  try {
    await invoke(task.command, { ...task.args, taskId: task.id });
    task.percent = 100;
    syncTaskUI();
    await reloadPhotosAfterRescan();
    if (task.stopRequested) showWriteToast(t('Task stopped: {name}', { name: taskName(task) }));
  } catch (error) {
    console.error('Rescan impossible', error);
    showWriteToast(t('Rescan failed: {error}', { error }));
  } finally {
    const position = scanTasks.indexOf(task);
    if (position >= 0) scanTasks.splice(position, 1);
    syncTaskUI();
  }
}

document.getElementById('btn-rescan-folders').addEventListener('click', () => enqueueScanTask({ kind: 'rescan-all', path: null, command: 'rescan_all_folders', args: {}, labelKey: 'Collection data rescan', labelParams: undefined }));

// Rescan d'un dossier de l'arborescence (sous-dossiers compris), lancé depuis son menu contextuel.
function rescanFolder(path) {
  return enqueueScanTask({ kind: 'rescan-folder', path, command: 'rescan_folder', args: { path }, labelKey: 'Folder data rescan: {folder}', labelParams: { folder: folderBaseName(path) } });
}

// ==========================================
// APERÇU : ZOOM, DÉPLACEMENT ET MODE COMPARER
// ==========================================
const MAX_COMPARE = 4;
const PREVIEW_ZOOM_STEP = 1.4; // +40 % par cran
const PREVIEW_MAX_ZOOM = 2; // 200 % de la résolution réelle (1 pixel image = 2 pixels écran)
const PREVIEW_FIT_MARGIN = 0.95; // marge de la vue entière, comme l'ancien aperçu
let compareMode = false;
let previewSlots = [];
let previewSignature = '';
let previewCenter = { x: 0.5, y: 0.5 }; // point de l'image au centre de la zone, en proportion (partagé entre les images)
let previewDrag = null;
let previewWheelDelta = 0;
let previewLastWheelStep = 0;
let compareDesync = false; // case « Désynchroniser » (mode Comparer uniquement)
let previewDesynced = false; // état réellement appliqué : mode Comparer actif ET case cochée
let hoveredPreviewSlot = null;
// Sous-sélection du mode Comparer (plusieurs photos comparées) : chemins des photos de l'aperçu qui reçoivent les commandes de note, de couleur et de suppression au clavier ou depuis la barre latérale. Vide par défaut.
const compareSubSelection = new Set();
let suppressPreviewClick = false; // le clic qui suit un déplacement de l'image dans l'aperçu ne change pas la sous-sélection
let previewHiddenBeforeCompare = false; // l'aperçu était masqué avant l'activation du mode Comparer : il est masqué de nouveau à sa désactivation
const PREVIEW_CLICK_DRAG_THRESHOLD = 5; // pixels avant de considérer un déplacement (sinon c'est un clic)
// Icône lucide « circle-check-big » : repère d'une photo de la sous-sélection (coin supérieur droit de sa case dans l'aperçu).
const CIRCLE_CHECK_BIG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check-big"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';

function canAddToSelection(index) {
  return selectedIndices.has(index) || !compareMode || selectedIndices.size < MAX_COMPARE;
}

function showCompareLimitToast() {
  showWriteToast(t('Compare mode: {max} photos maximum', { max: MAX_COMPARE }));
}

function limitSelectionForCompare() {
  if (selectedIndices.size <= MAX_COMPARE) return;
  const kept = new Set();
  if (selectedIndices.has(lastSelectedIndex)) kept.add(lastSelectedIndex);
  for (const index of [...selectedIndices].sort((a, b) => a - b)) {
    if (kept.size >= MAX_COMPARE) break;
    kept.add(index);
  }
  selectedIndices = kept;
  showCompareLimitToast();
}

// Comparaison de plusieurs photos : les cases de l'aperçu servent alors à choisir les photos visées par les commandes.
function isCompareMultiple() {
  return compareMode && selectedIndices.size > 1;
}

// Photos (indices dans photos) visées par les notes, les couleurs et la suppression au clavier, et par la barre latérale.
// Hors comparaison, ou avec une seule photo sélectionnée : toute la sélection. Comparaison de plusieurs photos : uniquement la sous-sélection (aucune par défaut).
// Les commandes du menu contextuel n'en dépendent pas : elles visent toujours la photo du clic droit.
function commandTargetIndices() {
  if (!isCompareMultiple()) return [...selectedIndices];
  return [...selectedIndices].filter(index => compareSubSelection.has(photos[index]?.path));
}

function commandTargetPhotos() {
  return commandTargetIndices().map(index => photos[index]).filter(Boolean);
}

// Photo dont la note et la couleur sont affichées dans la barre latérale.
function commandReferencePhoto() {
  const indices = commandTargetIndices();
  return photos[indices.includes(lastSelectedIndex) ? lastSelectedIndex : indices[0]];
}

// Retire de la sous-sélection les photos qui ne font plus partie de la comparaison (changement de sélection, suppression, fin du mode Comparer).
function pruneCompareSubSelection() {
  if (!isCompareMultiple()) {
    compareSubSelection.clear();
    return;
  }
  const comparedPaths = new Set([...selectedIndices].map(index => photos[index]?.path));
  for (const path of compareSubSelection) if (!comparedPaths.has(path)) compareSubSelection.delete(path);
}

// Repères circle-check-big des cases de l'aperçu, d'après la sous-sélection.
function syncPreviewSubSelection() {
  previewStage.classList.toggle('sub-selectable', isCompareMultiple());
  for (const slot of previewSlots) slot.cell.classList.toggle('sub-selected', compareSubSelection.has(slot.photo.path));
}

function toggleCompareSubSelection(photo) {
  if (compareSubSelection.has(photo.path)) compareSubSelection.delete(photo.path);
  else compareSubSelection.add(photo.path);
  syncPreviewSubSelection();
  updateRatingAction();
  updateColorAction();
}

// Place les repères (sous-sélection, étoiles, couleur) dans les coins de la partie visible de l'image, et non de la case : l'image peut être plus petite que sa case (bandes vides)
// ou la dépasser (zoom).
function positionPreviewMarks(slot, cellWidth, cellHeight) {
  if (!slot.meta) return; // le plein écran n'a pas de repères
  const left = Math.max(0, slot.tx);
  const top = Math.max(0, slot.ty);
  const right = Math.min(cellWidth, slot.tx + slot.displayWidth);
  const bottom = Math.min(cellHeight, slot.ty + slot.displayHeight);
  slot.check.style.top = `${Math.round(top) + 8}px`;
  slot.check.style.right = `${Math.round(cellWidth - right) + 8}px`;
  slot.meta.style.left = `${Math.round(left)}px`;
  slot.meta.style.right = `${Math.round(cellWidth - right)}px`;
  slot.meta.style.bottom = `${Math.round(cellHeight - bottom)}px`;
}

// Touche A : sous-sélectionne toutes les photos comparées, ou les désélectionne toutes si elles le sont déjà.
function toggleAllCompareSubSelection() {
  const paths = [...selectedIndices].map(index => photos[index]?.path).filter(Boolean);
  if (paths.every(path => compareSubSelection.has(path))) compareSubSelection.clear();
  else for (const path of paths) compareSubSelection.add(path);
  syncPreviewSubSelection();
  updateRatingAction();
  updateColorAction();
}

function notifyNoCompareTarget() {
  showWriteToast(t('Compare mode: first click one or more photos in the preview'));
}

// Échelle exprimée en pixels écran réels par pixel image (1 = 100 %). Échelle CSS = échelle / devicePixelRatio.
function previewCssScale(slot) {
  return (slot.zoom ?? slot.fit) / (window.devicePixelRatio || 1);
}

function previewDisplaySize(slot) {
  const scale = previewCssScale(slot);
  return { width: slot.naturalWidth * scale, height: slot.naturalHeight * scale };
}

function clampPreviewCenter(slot, x, y) {
  const { width, height } = previewDisplaySize(slot);
  const clampAxis = (value, shown, view) => {
    if (shown <= view) return 0.5;
    const half = view / 2 / shown;
    return Math.min(1 - half, Math.max(half, value));
  };
  return { x: clampAxis(x, width, slot.cell.clientWidth), y: clampAxis(y, height, slot.cell.clientHeight) };
}

function layoutPreviewSlot(slot) {
  if (!(slot.naturalWidth > 0 && slot.naturalHeight > 0)) return;
  const cellWidth = slot.cell.clientWidth;
  const cellHeight = slot.cell.clientHeight;
  if (!cellWidth || !cellHeight) return;
  const dpr = window.devicePixelRatio || 1;
  const fitMargin = slot.fitMargin ?? PREVIEW_FIT_MARGIN; // le plein écran utilise toute la fenêtre (marge 1)
  slot.fit = Math.min(1, (cellWidth * fitMargin * dpr) / slot.naturalWidth, (cellHeight * fitMargin * dpr) / slot.naturalHeight);
  if (slot.zoom !== null) {
    slot.zoom = Math.min(PREVIEW_MAX_ZOOM, Math.max(slot.fit, slot.zoom));
    if (slot.zoom <= slot.fit + 1e-6) slot.zoom = null;
  }
  const { width, height } = previewDisplaySize(slot);
  const currentCenter = previewCenterOf(slot);
  const center = clampPreviewCenter(slot, currentCenter.x, currentCenter.y);
  const snap = value => Math.round(value * dpr) / dpr;
  slot.tx = snap(width <= cellWidth ? (cellWidth - width) / 2 : cellWidth / 2 - center.x * width);
  slot.ty = snap(height <= cellHeight ? (cellHeight - height) / 2 : cellHeight / 2 - center.y * height);
  slot.displayWidth = width;
  slot.displayHeight = height;
  slot.img.style.transform = `translate(${slot.tx}px, ${slot.ty}px) scale(${previewCssScale(slot)})`;
  positionPreviewMarks(slot, cellWidth, cellHeight);
}

function renderPreviewTransforms() {
  previewSlots.forEach(layoutPreviewSlot);
  layoutFullscreenSlot();
}

function createPreviewSlot(photo) {
  const cell = document.createElement('div');
  cell.className = 'preview-cell';
  cell.dataset.path = photo.path;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  const slot = { photo, cell, img, naturalWidth: 0, naturalHeight: 0, fit: 1, zoom: null, tx: 0, ty: 0, displayWidth: 0, displayHeight: 0, center: { x: 0.5, y: 0.5 } };
  img.addEventListener('load', () => {
    if (!previewSlots.includes(slot)) return;
    if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
    slot.naturalWidth = img.naturalWidth;
    slot.naturalHeight = img.naturalHeight;
    img.style.width = `${slot.naturalWidth}px`;
    img.style.height = `${slot.naturalHeight}px`;
    cell.classList.add('loaded');
    layoutPreviewSlot(slot);
  });
  img.addEventListener('error', () => checkPhotoMissing(photo.path));
  img.addEventListener('error', () => checkPhotoMissing(photo.path));
  getPhotoDisplayUrl(photo).then(url => {
    if (previewSlots.includes(slot)) {
      img.src = url;
    }
  });
  const check = document.createElement('span');
  check.className = 'preview-check';
  check.setAttribute('aria-hidden', 'true');
  check.innerHTML = CIRCLE_CHECK_BIG_ICON;
  // Note (à gauche) et couleur (à droite) de la photo, en bas de la case.
  const meta = document.createElement('div');
  meta.className = 'preview-meta';
  slot.ratingLabel = document.createElement('span');
  slot.ratingLabel.className = 'thumbnail-rating';
  slot.flagDot = document.createElement('span');
  slot.flagDot.className = 'flag-indicator flag-none';
  meta.append(slot.ratingLabel, slot.flagDot);
  cell.append(img, check, meta);
  slot.check = check;
  slot.meta = meta;
  return slot;
}

// Mode normal : la photo courante. Mode Comparer : la sélection (4 max), dans l'ordre de la grille.
function currentPreviewPhotos() {
  if (compareMode) {
    return [...selectedIndices].sort((a, b) => a - b).slice(0, MAX_COMPARE).map(index => photos[index]).filter(Boolean);
  }
  if (selectedIndices.size === 0) return []; // rien de sélectionné (Ctrl+A pour tout désélectionner) : aperçu vide
  const photo = photos[lastSelectedIndex];
  return photo ? [photo] : [];
}

// Étoiles et pastille de couleur affichées en bas des cases de l'aperçu, d'après l'état actuel des photos.
function syncPreviewMeta() {
  for (const slot of previewSlots) {
    const stars = '★'.repeat(slot.photo.rating || 0);
    if (slot.ratingLabel.textContent !== stars) slot.ratingLabel.textContent = stars;
    const flagClass = `flag-indicator flag-${slot.photo.color_flag || 'none'}`;
    if (slot.flagDot.className !== flagClass) slot.flagDot.className = flagClass;
  }
}

function renderPreview() {
  pruneCompareSubSelection();
  const list = currentPreviewPhotos();
  const signature = list.map(photo => photo.path).join('|');
  if (signature === previewSignature) { // mêmes images : on garde zoom et position
    previewSlots.forEach((slot, index) => { slot.photo = list[index]; }); // objets renouvelés après une synchronisation
    syncPreviewMeta();
    syncPreviewSubSelection();
    return;
  }
  previewSignature = signature;
  previewCenter = { x: 0.5, y: 0.5 };
  previewDrag = null;
  hoveredPreviewSlot = null;
  previewSlots = list.map(createPreviewSlot);
  previewStage.className = list.length ? `preview-stage count-${list.length}` : 'preview-stage';
  previewStage.replaceChildren(...previewSlots.map(slot => slot.cell));
  renderPreviewTransforms();
  syncPreviewMeta();
  syncPreviewSubSelection();
}

function previewSlotFromEvent(event) {
  const cell = event.target instanceof Element ? event.target.closest('.preview-cell') : null;
  return cell ? previewSlots.find(slot => slot.cell === cell) || null : null;
}

// Point de l'image situé sous le curseur (en proportion de l'image), pour zoomer autour de lui.
function previewAnchorAt(slot, clientX, clientY) {
  const rect = slot.cell.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const clamp01 = value => Math.min(1, Math.max(0, value));
  return {
    slot, px, py,
    u: slot.displayWidth > 0 ? clamp01((px - slot.tx) / slot.displayWidth) : 0.5,
    v: slot.displayHeight > 0 ? clamp01((py - slot.ty) / slot.displayHeight) : 0.5,
  };
}

// Centre de la zone affichée : propre à chaque image en mode désynchronisé, sinon partagé.
// Le plein écran a toujours son propre centre (une seule image, indépendante de l'aperçu).
function previewCenterOf(slot) {
  return previewDesynced || slot === fullscreenSlot ? slot.center : previewCenter;
}

function setPreviewCenter(slot, center) {
  if (previewDesynced || slot === fullscreenSlot) slot.center = center;
  else previewCenter = center;
}

// En mode désynchronisé, une action vise l'image concernée ; sinon elle s'applique à toutes.
function previewSlotsToAffect(targetSlot) {
  // Plein écran ouvert : les touches + / - / * (et le zoom en général) ne visent que son image.
  if (isFullscreen) return fullscreenSlot.naturalWidth > 0 ? [fullscreenSlot] : [];
  const loaded = previewSlots.filter(slot => slot.naturalWidth > 0);
  return previewDesynced && targetSlot ? loaded.filter(slot => slot === targetSlot) : loaded;
}

// Applique le passage synchronisé / désynchronisé sans déplacer les images à l'écran.
function updatePreviewSyncMode() {
  const desynced = compareMode && compareDesync;
  if (desynced === previewDesynced) return;
  if (desynced) {
    for (const slot of previewSlots) slot.center = { ...previewCenter };
  } else {
    const reference = previewSlots.find(slot => slot.zoom !== null) || previewSlots[0];
    if (reference) previewCenter = { ...reference.center };
  }
  previewDesynced = desynced;
  renderPreviewTransforms();
}

// computeTarget(slot, échelleActuelle) renvoie la nouvelle échelle, ou null pour la vue entière.
function zoomPreview(computeTarget, anchor, targetSlot = null) {
  const slots = previewSlotsToAffect(targetSlot);
  if (!slots.length) return;
  for (const slot of slots) {
    const target = computeTarget(slot, slot.zoom ?? slot.fit);
    slot.zoom = target === null || target <= slot.fit + 1e-6 ? null : Math.min(PREVIEW_MAX_ZOOM, target);
  }
  if (previewDesynced || isFullscreen) {
    for (const slot of slots) if (slot.zoom === null) slot.center = { x: 0.5, y: 0.5 };
  } else if (slots.every(slot => slot.zoom === null)) {
    previewCenter = { x: 0.5, y: 0.5 };
  }
  if (anchor && anchor.slot.zoom !== null && slots.includes(anchor.slot)) {
    const { width, height } = previewDisplaySize(anchor.slot);
    if (width > 0 && height > 0) {
      setPreviewCenter(anchor.slot, clampPreviewCenter(
        anchor.slot,
        anchor.u + (anchor.slot.cell.clientWidth / 2 - anchor.px) / width,
        anchor.v + (anchor.slot.cell.clientHeight / 2 - anchor.py) / height,
      ));
    }
  }
  renderPreviewTransforms();
}

function zoomPreviewSteps(steps, anchor, targetSlot = null) {
  zoomPreview((slot, current) => current * Math.pow(PREVIEW_ZOOM_STEP, steps), anchor, targetSlot);
}

// 100 % (1 pixel image = 1 pixel écran) ; si toutes les images y sont déjà, retour à la vue entière.
function togglePreviewActualSize(anchor, targetSlot = null) {
  const slots = previewSlotsToAffect(targetSlot);
  if (!slots.length) return;
  const atActualSize = slots.every(slot => Math.abs((slot.zoom ?? slot.fit) - 1) < 0.005);
  zoomPreview(() => (atActualSize ? null : 1), anchor, targetSlot);
}

// Nombre de crans de zoom correspondant à un événement de molette, ou 0 si aucun cran n'est atteint : une molette à crans donne un cran par
// événement (avec un court délai anti-rebond), un pavé tactile envoie de petits déplacements qui sont cumulés. Partagé par l'aperçu et le plein écran.
function wheelZoomSteps(event) {
  const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 33 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1);
  if (Math.abs(delta) >= 50) {
    const now = performance.now();
    if (now - previewLastWheelStep < 40) return 0;
    previewLastWheelStep = now;
    previewWheelDelta = 0;
    return Math.sign(delta);
  }
  previewWheelDelta += delta;
  const steps = Math.trunc(previewWheelDelta / 100);
  previewWheelDelta -= steps * 100;
  return steps;
}

previewStage.addEventListener('wheel', event => {
  const slot = previewSlotFromEvent(event);
  if (!slot) return;
  event.preventDefault();
  const steps = wheelZoomSteps(event);
  if (steps) zoomPreviewSteps(-steps, previewAnchorAt(slot, event.clientX, event.clientY), slot);
}, { passive: false });

previewStage.addEventListener('dblclick', event => {
  const slot = previewSlotFromEvent(event);
  if (slot) togglePreviewActualSize(previewAnchorAt(slot, event.clientX, event.clientY), slot);
});

previewStage.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const slot = previewSlotFromEvent(event);
  if (!slot) return;
  previewDrag = { slot, pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
  slot.cell.setPointerCapture(event.pointerId);
  slot.cell.classList.add('dragging');
});

previewStage.addEventListener('pointermove', event => {
  if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
  const { slot } = previewDrag;
  if (!previewDrag.moved && Math.hypot(event.clientX - previewDrag.startX, event.clientY - previewDrag.startY) >= PREVIEW_CLICK_DRAG_THRESHOLD) previewDrag.moved = true;
  const dx = event.clientX - previewDrag.x;
  const dy = event.clientY - previewDrag.y;
  previewDrag.x = event.clientX;
  previewDrag.y = event.clientY;
  if (slot.zoom === null || !(slot.displayWidth > 0 && slot.displayHeight > 0)) return;
  const currentCenter = previewCenterOf(slot);
  setPreviewCenter(slot, clampPreviewCenter(slot, currentCenter.x - dx / slot.displayWidth, currentCenter.y - dy / slot.displayHeight));
  renderPreviewTransforms();
});

function endPreviewDrag(event) {
  if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
  if (previewDrag.moved) {
    // Le clic qui suit un déplacement de l'image ne doit pas changer la sous-sélection.
    suppressPreviewClick = true;
    setTimeout(() => { suppressPreviewClick = false; }, 0);
  }
  previewDrag.slot.cell.classList.remove('dragging');
  previewDrag = null;
}
previewStage.addEventListener('pointerup', endPreviewDrag);
previewStage.addEventListener('pointercancel', endPreviewDrag);

// Comparaison de plusieurs photos : un clic sur une case de l'aperçu ajoute ou retire sa photo de la sous-sélection.
// Un double-clic (zoom 1:1) compte deux clics et laisse donc la sous-sélection inchangée.
previewStage.addEventListener('click', event => {
  if (suppressPreviewClick) {
    suppressPreviewClick = false;
    return;
  }
  if (!isCompareMultiple()) return;
  const slot = previewSlotFromEvent(event);
  if (slot) toggleCompareSubSelection(slot.photo);
});

new ResizeObserver(() => renderPreviewTransforms()).observe(previewStage);

// Image survolée : cible des touches + / - / * en mode désynchronisé
previewStage.addEventListener('pointerover', event => {
  const slot = previewSlotFromEvent(event);
  if (slot) hoveredPreviewSlot = slot;
});
previewStage.addEventListener('pointerleave', () => { hoveredPreviewSlot = null; });

document.getElementById('compare-desync-toggle').addEventListener('change', event => {
  compareDesync = event.target.checked;
  updatePreviewSyncMode();
  event.target.blur(); // sinon les touches + / - / * seraient ignorées tant que la case a le focus
});

document.getElementById('btn-toggle-compare').addEventListener('click', event => {
  compareMode = !compareMode;
  event.currentTarget.classList.toggle('active', compareMode);
  document.getElementById('btn-toggle-preview').disabled = compareMode; // l'aperçu reste affiché tant que le mode Comparer est actif
  const desyncOption = document.getElementById('compare-desync');
  desyncOption.classList.toggle('hidden', !compareMode);
  desyncOption.style.display = compareMode ? '' : 'none';
  updatePreviewSyncMode();
  if (compareMode) {
    previewHiddenBeforeCompare = mainContent.classList.contains('preview-hidden');
    if (previewHiddenBeforeCompare) {
      mainContent.classList.remove('preview-hidden');
      document.getElementById('btn-toggle-preview').classList.add('active');
      requestAnimationFrame(updateVirtualScroller);
    }
    limitSelectionForCompare();
  } else if (previewHiddenBeforeCompare) {
    previewHiddenBeforeCompare = false;
    mainContent.classList.add('preview-hidden');
    document.getElementById('btn-toggle-preview').classList.remove('active');
    requestAnimationFrame(updateVirtualScroller);
  }
  updateUIOnSelection();
});

// ==========================================
// DÉFILEMENT DE LA GRILLE AU GLISSER
// ==========================================
const GRID_DRAG_THRESHOLD = 5; // pixels avant de considérer un glissement (sinon c'est un clic)
let gridDrag = null;
let photoDrag = null; // glisser-déposer de photos vers l'arborescence (voir plus bas)
let suppressGridClick = false;

// Inertie : au relâchement d'un glissement rapide, le défilement continue puis ralentit progressivement (décroissance exponentielle,
// indépendante de la cadence d'affichage). La distance totale parcourue vaut vitesse initiale x GRID_INERTIA_TIME_CONSTANT_MS.
const GRID_INERTIA_TIME_CONSTANT_MS = 325; // plus la valeur est grande, plus le défilement dure et va loin
const GRID_INERTIA_VELOCITY_WINDOW_MS = 100; // fenêtre de mesure de la vitesse juste avant le relâchement
const GRID_INERTIA_MAX_IDLE_MS = 60; // pointeur immobile plus longtemps avant le relâchement : pas d'inertie
const GRID_INERTIA_MIN_VELOCITY = 0.1; // px/ms nécessaires pour lancer l'inertie
const GRID_INERTIA_STOP_VELOCITY = 0.02; // px/ms : en dessous, le défilement s'arrête
const GRID_INERTIA_MAX_VELOCITY = 6; // px/ms
let gridInertia = null; // { frame, velocity, position, lastTime } pendant l'inertie

// Arrête l'inertie en cours ; renvoie true si la grille était encore en train de défiler.
function stopGridInertia() {
  if (!gridInertia) return false;
  cancelAnimationFrame(gridInertia.frame);
  gridInertia = null;
  return true;
}

function startGridInertia(velocity) {
  stopGridInertia();
  const state = { frame: 0, velocity, position: gridContainer.scrollTop, lastTime: performance.now() };
  gridInertia = state;
  const step = now => {
    if (gridInertia !== state) return;
    // scrollTop modifié ailleurs (barre de défilement, changement de filtre ou de tri…) : l'inertie s'efface.
    if (Math.abs(gridContainer.scrollTop - state.position) > 2) { stopGridInertia(); return; }
    const elapsed = Math.min(50, Math.max(0, now - state.lastTime));
    state.lastTime = now;
    const decay = Math.exp(-elapsed / GRID_INERTIA_TIME_CONSTANT_MS);
    state.position += state.velocity * GRID_INERTIA_TIME_CONSTANT_MS * (1 - decay);
    state.velocity *= decay;
    const maxScroll = Math.max(0, gridContainer.scrollHeight - gridContainer.clientHeight);
    const clamped = Math.max(0, Math.min(maxScroll, state.position));
    gridContainer.scrollTop = clamped;
    // Haut ou bas de la grille atteint, ou vitesse devenue négligeable : fin du défilement.
    if (clamped !== state.position || Math.abs(state.velocity) < GRID_INERTIA_STOP_VELOCITY) { stopGridInertia(); return; }
    state.frame = requestAnimationFrame(step);
  };
  state.frame = requestAnimationFrame(step);
}

// Vitesse mesurée sur les derniers instants du glissement (pointeur immobile avant le relâchement = pas d'inertie).
function releaseGridInertia(samples, releaseTime) {
  const last = samples[samples.length - 1];
  if (!last || releaseTime - last.time > GRID_INERTIA_MAX_IDLE_MS) return;
  const first = samples[0];
  const duration = last.time - first.time;
  if (duration < 8) return; // trop peu de mesures pour estimer une vitesse fiable
  const velocity = Math.max(-GRID_INERTIA_MAX_VELOCITY, Math.min(GRID_INERTIA_MAX_VELOCITY, -(last.y - first.y) / duration));
  if (Math.abs(velocity) < GRID_INERTIA_MIN_VELOCITY) return;
  startGridInertia(velocity);
}

// La molette reprend la main sur une inertie en cours.
gridContainer.addEventListener('wheel', stopGridInertia, { passive: true });

gridContainer.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.pointerType === 'touch') return;
  const stoppedInertia = stopGridInertia(); // un clic sur la grille qui défile l'arrête
  const bounds = gridContainer.getBoundingClientRect();
  if (event.clientX - bounds.left >= gridContainer.clientWidth) return; // barre de défilement
  // Maj + bouton tenu sur une miniature : on glisse les photos vers un dossier de l'arborescence pour les déplacer ; Ctrl + bouton tenu : pour les copier
  // (le glissement simple fait défiler la grille).
  const pressedThumbnail = (event.shiftKey || event.ctrlKey) && event.target instanceof Element ? event.target.closest('.thumbnail') : null;
  if (pressedThumbnail) {
    photoDrag = { pointerId: event.pointerId, mode: event.shiftKey ? 'move' : 'copy', startX: event.clientX, startY: event.clientY, index: Number(pressedThumbnail.dataset.index), active: false, cancelled: false, targets: [], ghost: null, dropItem: null };
    return;
  }
  gridDrag = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: gridContainer.scrollTop, active: false, stoppedInertia, samples: [] };
});

gridContainer.addEventListener('pointermove', event => {
  if (!gridDrag || event.pointerId !== gridDrag.pointerId) return;
  const delta = event.clientY - gridDrag.startY;
  if (!gridDrag.active) {
    if (Math.abs(delta) < GRID_DRAG_THRESHOLD) return;
    gridDrag.active = true;
    gridContainer.setPointerCapture(event.pointerId);
    gridContainer.classList.add('dragging-scroll');
  }
  gridContainer.scrollTop = gridDrag.startScrollTop - delta;
  // Derniers points du glissement, pour estimer la vitesse au relâchement.
  const samples = gridDrag.samples;
  samples.push({ time: event.timeStamp, y: event.clientY });
  while (samples.length > 1 && event.timeStamp - samples[0].time > GRID_INERTIA_VELOCITY_WINDOW_MS) samples.shift();
});

function endGridDrag(event) {
  if (!gridDrag || event.pointerId !== gridDrag.pointerId) return;
  const { active, stoppedInertia, samples } = gridDrag;
  if (active || stoppedInertia) {
    // Le clic qui suit un glissement (ou qui vient d'arrêter l'inertie) ne doit pas changer la sélection.
    suppressGridClick = true;
    setTimeout(() => { suppressGridClick = false; }, 0);
  }
  if (active) {
    gridContainer.classList.remove('dragging-scroll');
    if (event.type === 'pointerup') releaseGridInertia(samples, event.timeStamp); // pas d'inertie si le glissement est annulé
  }
  gridDrag = null;
}
// Bloque le glisser-déposer natif (image fantôme, icône « interdit ») qui interrompt le défilement
gridContainer.addEventListener('dragstart', event => event.preventDefault());
gridContainer.addEventListener('pointerup', endGridDrag);
gridContainer.addEventListener('pointercancel', endGridDrag);
gridContainer.addEventListener('click', event => {
  if (!suppressGridClick) return;
  suppressGridClick = false;
  event.stopPropagation();
  event.preventDefault();
}, true);

// ==========================================
// DÉPLACEMENT ET COPIE DE PHOTOS PAR GLISSER-DÉPOSER VERS L'ARBORESCENCE
// ==========================================
// Maj + bouton tenu sur une miniature, puis glisser sur un dossier de l'arborescence et relâcher : les photos sélectionnées y sont déplacées
// (fichiers déplacés sur le disque). Avec Ctrl au lieu de Maj, elles sont copiées (un « + » vert s'affiche sur la vignette). Si la miniature saisie
// n'est pas sélectionnée, seule elle est concernée. Échap annule. Un simple Maj + clic ou Ctrl + clic, sans glissement, garde son rôle habituel
// (sélection d'une plage, ajout ou retrait de la sélection).
const PHOTO_DRAG_THRESHOLD = 6; // pixels avant de considérer un glissement (sinon c'est un clic)
let photoMoveRunning = false;

function folderItemAt(x, y) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest('#folder-tree .folder-tree-item[data-folder-path]') : null;
}

// Premier déplacement au-delà du seuil : fixe les photos concernées et crée l'image qui suit le curseur.
function startPhotoDrag(drag) {
  if (!selectedIndices.has(drag.index)) {
    selectedIndices.clear();
    selectedIndices.add(drag.index);
    lastSelectedIndex = drag.index;
    updateUIOnSelection();
  }
  drag.targets = [...selectedIndices].sort((a, b) => a - b).map(index => photos[index]).filter(Boolean);
  if (!drag.targets.length) return false;
  drag.active = true;
  gridContainer.setPointerCapture(drag.pointerId); // les événements continuent d'arriver au-dessus de l'arborescence
  const ghost = document.createElement('div');
  ghost.className = drag.mode === 'copy' ? 'drag-ghost copy' : 'drag-ghost';
  const source = renderedThumbnailNodes.get(drag.index)?._thumbnailImage;
  if (source?.src) {
    const image = document.createElement('img');
    image.src = source.src;
    image.alt = '';
    ghost.append(image);
  }
  const badge = document.createElement('span');
  badge.textContent = String(drag.targets.length);
  ghost.append(badge);
  document.body.append(ghost);
  drag.ghost = ghost;
  document.body.classList.add('dragging-photos');
  return true;
}

function clearPhotoDragVisuals(drag) {
  drag.ghost?.remove();
  drag.ghost = null;
  drag.dropItem?.classList.remove('drop-target');
  drag.dropItem = null;
  document.body.classList.remove('dragging-photos');
}

gridContainer.addEventListener('pointermove', event => {
  const drag = photoDrag;
  if (!drag || drag.cancelled || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < PHOTO_DRAG_THRESHOLD) return;
    if (!startPhotoDrag(drag)) { photoDrag = null; return; }
  }
  drag.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
  const item = folderItemAt(event.clientX, event.clientY);
  if (item !== drag.dropItem) {
    drag.dropItem?.classList.remove('drop-target');
    item?.classList.add('drop-target');
    drag.dropItem = item;
  }
});

function endPhotoDrag(event, released) {
  const drag = photoDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  photoDrag = null;
  if (!drag.active) return; // Maj ou Ctrl + clic simple : le clic gère la sélection
  clearPhotoDragVisuals(drag);
  // Le clic qui suit un glissement ne doit pas changer la sélection.
  suppressGridClick = true;
  setTimeout(() => { suppressGridClick = false; }, 0);
  if (!released || drag.cancelled) return;
  const folderPath = folderItemAt(event.clientX, event.clientY)?.dataset.folderPath;
  if (!folderPath) return;
  if (drag.mode === 'copy') copyPhotosToFolder(drag.targets, folderPath);
  else movePhotosToFolder(drag.targets, folderPath);
}
gridContainer.addEventListener('pointerup', event => endPhotoDrag(event, true));
gridContainer.addEventListener('pointercancel', event => endPhotoDrag(event, false));
// Échap pendant le glissement : annule le déplacement (le relâché du bouton ne fait alors plus rien).
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !photoDrag?.active || photoDrag.cancelled) return;
  event.preventDefault();
  photoDrag.cancelled = true;
  clearPhotoDragVisuals(photoDrag);
});

// Met à jour l'interface après la suppression d'un dossier (voir delete_folder) : photos retirées de la vue sans recharger la bibliothèque, dossiers
// vides créés pendant la session oubliés. Si le dossier affiché est concerné, on revient à son dossier parent.
function applyDeletedFolder(deletedPath, removedPaths) {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const deleted = normalize(deletedPath);
  const isInside = value => normalize(value) === deleted || normalize(value).startsWith(`${deleted}/`);
  for (const created of [...createdFolders]) if (isInside(created)) createdFolders.delete(created);
  for (const key of [...folderTreeExpanded]) if (isInside(key)) folderTreeExpanded.delete(key);
  const viewAffected = currentFolderFilter !== null && isInside(currentFolderFilter);
  removePhotosFromLibrary(removedPaths);
  renderFolderTree();
  // Le dossier supprimé n'est jamais un dossier suivi : son parent l'est, ou en fait partie.
  if (viewAffected) selectFolder(deletedPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, ''));
}

// Dossier de l'arborescence vers la corbeille, ou supprimé définitivement quand son support n'en a pas (`permanent`, détecté avant la confirmation par
// photo-actions.js, qui a aussi demandé la confirmation). Le même indicateur que le déplacement suspend la synchronisation automatique pendant l'opération.
async function deleteFolderToTrash(path, { permanent = false } = {}) {
  if (photoMoveRunning) return;
  photoMoveRunning = true;
  showWriteToast(t(permanent ? 'Deleting folder…' : 'Moving folder to the trash…'), true);
  try {
    const removedPaths = await invoke('delete_folder', { path });
    applyDeletedFolder(path, removedPaths);
    showWriteToast(t(permanent ? 'Folder deleted' : 'Folder moved to the trash'));
  } catch (error) {
    showWriteToast(t('Folder deletion failed: {error}', { error }));
  } finally {
    photoMoveRunning = false;
  }
}

async function movePhotosToFolder(targets, folderPath) {
  if (photoMoveRunning || !targets.length) return;
  photoMoveRunning = true;
  showWriteToast(tp('Moving {count} file…', targets.length), true);
  try {
    const result = await invoke('move_photos', { paths: targets.map(photo => photo.path), destination: folderPath });
    if (result.failed.length) console.error('Déplacement : échecs', result.failed);
    if (result.moved.length) await applyMovedPhotos(result.moved);
    const parts = [];
    if (result.moved.length) parts.push(tp('{count} file moved', result.moved.length));
    if (result.skipped) parts.push(tp('{count} file already in this folder', result.skipped));
    if (result.failed.length) parts.push(tp('{count} failure', result.failed.length));
    showWriteToast(!result.moved.length && !result.skipped && result.failed.length
      ? t('Move failed: {error}', { error: result.failed[0].error })
      : parts.join(' · '));
  } catch (error) {
    showWriteToast(t('Move failed: {error}', { error }));
  } finally {
    photoMoveRunning = false;
  }
}

// Copie (Ctrl + glisser) : les fichiers originaux sont copiés dans le dossier, puis la synchronisation incrémentale les ajoute au catalogue (le backend
// ne lit que les nouveaux fichiers). Le même indicateur que le déplacement suspend la synchronisation automatique pendant l'opération.
async function copyPhotosToFolder(targets, folderPath) {
  if (photoMoveRunning || !targets.length) return;
  photoMoveRunning = true;
  showWriteToast(tp('Copying {count} file…', targets.length), true);
  try {
    const result = await invoke('copy_photos_to_tracked_folder', { paths: targets.map(photo => photo.path), destination: folderPath });
    if (result.failed.length) console.error('Copie : échecs', result.failed);
    if (result.copied) {
      const changes = await invoke('sync_library');
      if (changes.added.length || changes.updated.length || changes.removed.length) await refreshLibraryAfterSync(changes);
    }
    showWriteToast(!result.copied && result.failed.length
      ? t('Copy failed: {error}', { error: result.failed[0].error })
      : `${tp('{count} file copied', result.copied)}${result.failed.length ? ` · ${tp('{count} failure', result.failed.length)}` : ''}`);
  } catch (error) {
    showWriteToast(t('Copy failed: {error}', { error }));
  } finally {
    photoMoveRunning = false;
  }
}

// Met à jour l'interface après un déplacement. Les photos gardent leur objet (le chemin et le nom changent) pour que la sélection soit retrouvée par
// chemin, puis la liste est relue depuis la base sans remonter la grille : une photo déplacée hors du dossier affiché en disparaît.
async function applyMovedPhotos(moved) {
  const destinations = new Map(moved.map(item => [item.from, item.to]));
  const rename = list => {
    for (const photo of list) {
      const destination = destinations.get(photo.path);
      if (!destination) continue;
      thumbnailCacheLookups.delete(photo.path);
      photo.path = destination;
      photo.filename = destination.split(/[\\/]/).pop() || photo.filename;
      delete photo.folderPath; // recalculés par photoFolder() pour le tri et les séparateurs
      delete photo.folderSegments;
    }
  };
  rename(loadedPhotos);
  if (folderTreePhotos !== loadedPhotos) rename(folderTreePhotos);
  previewSignature = ''; // force le rechargement de l'aperçu
  fullscreenImageCache.clear();
  await refreshLibraryAfterSync({ added: [], updated: [], removed: [] });
}

// ==========================================
// FILTRE DE DATE (date de prise de vue EXIF)
// ==========================================
let dateFilter = null; // { from, to } au format AAAAMMJJHHmmss (nombres), ou null = aucun filtre
const dateFilterInput = document.getElementById('date-filter-input');
const dateFilterClear = document.getElementById('date-filter-clear');
const dateFilterCalendar = document.getElementById('date-filter-calendar');
const dateFilterError = document.getElementById('date-filter-error');

// Extrait la date et l'heure d'un texte EXIF quel que soit le séparateur (« 2026:08:12 14:30:00 », « 2026-08-12 14:30:00 »…).
// Renvoie un nombre AAAAMMJJHHmmss (heure à 00:00:00 si absente), ou null.
function extractTimeKey(text) {
  const match = /(\d{4})\D?(\d{2})\D?(\d{2})(?:\D+(\d{2})\D?(\d{2})(?:\D?(\d{2}))?)?/.exec(String(text || ''));
  if (!match) return null;
  if (Number(match[1] + match[2] + match[3]) < 10000101) return null; // ignore les dates vides du type 0000:00:00
  return Number(`${match[1]}${match[2]}${match[3]}${match[4] || '00'}${match[5] || '00'}${match[6] || '00'}`);
}

function photoTimeKey(photo) {
  if (photo.timeKey === undefined) photo.timeKey = extractTimeKey(photo.date_taken);
  return photo.timeKey;
}

// Jour de prise de vue au format AAAAMMJJ, ou null.
function photoDateKey(photo) {
  const key = photoTimeKey(photo);
  return key === null ? null : Math.floor(key / 1000000);
}

// Le filtre couvre du premier au dernier instant de la période saisie, bornes incluses.
function matchesDateFilter(photo) {
  if (!dateFilter) return true;
  const key = photoTimeKey(photo);
  return key !== null && key >= dateFilter.from && key <= dateFilter.to;
}

function isValidDateKey(key) {
  const year = Math.floor(key / 10000);
  const month = Math.floor(key / 100) % 100;
  const day = key % 100;
  const date = new Date(year, month - 1, day);
  return year >= 1000 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// Un jeton AAAA, AAAAMM, AAAAMMJJ, AAAAMMJJHH ou AAAAMMJJHHmm : renvoie le premier et le dernier instant
// (AAAAMMJJHHmmss) de la période. Les parties absentes valent le début (01, 00) ou la fin (12, 31, 23, 59, 59).
function parseDateToken(token) {
  const year = Number(token.slice(0, 4));
  const month = token.length >= 6 ? Number(token.slice(4, 6)) : null;
  const day = token.length >= 8 ? Number(token.slice(6, 8)) : null;
  const hour = token.length >= 10 ? Number(token.slice(8, 10)) : null;
  const minute = token.length >= 12 ? Number(token.slice(10, 12)) : null;
  if (year < 1000) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && !isValidDateKey(year * 10000 + month * 100 + day)) return null;
  if (hour !== null && hour > 23) return null;
  if (minute !== null && minute > 59) return null;
  const pad = value => String(value).padStart(2, '0');
  const build = (m, d, h, mi, s) => Number(`${year}${pad(m)}${pad(d)}${pad(h)}${pad(mi)}${pad(s)}`);
  return {
    start: build(month ?? 1, day ?? 1, hour ?? 0, minute ?? 0, 0),
    end: build(month ?? 12, day ?? 31, hour ?? 23, minute ?? 59, 59),
  };
}

function parseDateFilter(text) {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return { filter: null };
  const token = '(\\d{4}|\\d{6}|\\d{8}|\\d{10}|\\d{12})';
  const match = new RegExp(`^${token}(?:-${token})?$`).exec(compact);
  if (!match) return { error: t('Date format error') };
  const first = parseDateToken(match[1]);
  const second = match[2] ? parseDateToken(match[2]) : first;
  if (!first || !second) return { error: t('Invalid date') };
  if (!match[2]) return { filter: { from: first.start, to: first.end } };
  // Plage : début du premier jeton → fin du second. Si c'est à l'envers, on inverse les deux jetons.
  const [begin, finish] = first.start <= second.end ? [first, second] : [second, first];
  return { filter: { from: begin.start, to: finish.end } };
}

function updateDateFilterUI(error = '') {
  dateFilterClear.classList.toggle('has-value', dateFilterInput.value.trim() !== '');
  dateFilterInput.classList.toggle('invalid', Boolean(error));
  dateFilterInput.setAttribute('aria-invalid', error ? 'true' : 'false');
  dateFilterError.textContent = error;
}

// Applique le contenu du champ : vide = pas de filtre ; saisie incomplète ou invalide = filtre précédent conservé.
function setDateFilterFromInput() {
  const result = parseDateFilter(dateFilterInput.value);
  updateDateFilterUI(result.error);
  if (result.error) return;
  const next = result.filter;
  const unchanged = next === dateFilter || (next && dateFilter && next.from === dateFilter.from && next.to === dateFilter.to);
  if (unchanged) return;
  dateFilter = next;
  applyPhotoFilters();
}

dateFilterInput.addEventListener('input', () => {
  closeDatePicker();
  setDateFilterFromInput();
});

dateFilterClear.addEventListener('click', () => {
  dateFilterInput.value = '';
  closeDatePicker();
  setDateFilterFromInput();
});

// --- Calendrier (date unique ou plage) ---
const datePicker = document.createElement('div');
datePicker.className = 'date-picker';
datePicker.setAttribute('role', 'dialog');
datePicker.setAttribute('aria-label', t('Choose a date or a range'));
datePicker.style.display = 'none';
document.body.appendChild(datePicker);
// Initiales des jours (semaine commençant le lundi) et mois, selon la langue courante : le 1er janvier 2024 est un lundi.
const weekdayLabels = () => Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(getLanguage(), { weekday: 'narrow' }).format(new Date(2024, 0, 1 + day)));
const pickerMonthFormatter = () => new Intl.DateTimeFormat(getLanguage(), { month: 'long', year: 'numeric' });
let pickerYear = 0;
let pickerMonth = 0; // 0-11
let pickStart = null;
let pickEnd = null;
let pickAwaitingEnd = false;

function isDatePickerOpen() {
  return datePicker.style.display !== 'none';
}

function closeDatePicker() {
  datePicker.style.display = 'none';
}

function todayDateKey() {
  const now = new Date();
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

function latestPhotoDateKey() {
  let latest = null;
  for (const photo of loadedPhotos) {
    const key = photoDateKey(photo);
    if (key !== null && (latest === null || key > latest)) latest = key;
  }
  return latest;
}

function positionDatePicker() {
  const rect = dateFilterCalendar.getBoundingClientRect();
  const width = datePicker.offsetWidth;
  const height = datePicker.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  datePicker.style.left = `${left}px`;
  datePicker.style.top = `${top}px`;
}

function renderDatePicker() {
  const first = new Date(pickerYear, pickerMonth, 1);
  const offset = (first.getDay() + 6) % 7; // la semaine commence le lundi
  const daysInMonth = new Date(pickerYear, pickerMonth + 1, 0).getDate();
  const today = todayDateKey();
  const low = pickStart === null ? null : Math.min(pickStart, pickEnd ?? pickStart);
  const high = pickStart === null ? null : Math.max(pickStart, pickEnd ?? pickStart);
  let cells = weekdayLabels().map(label => `<span class="date-picker-weekday">${label}</span>`).join('');
  for (let i = 0; i < offset; i++) cells += '<span></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const key = pickerYear * 10000 + (pickerMonth + 1) * 100 + day;
    const classes = ['date-picker-day'];
    if (key === today) classes.push('today');
    if (low !== null && key > low && key < high) classes.push('in-range');
    if (key === low || key === high) classes.push('selected');
    cells += `<button type="button" class="${classes.join(' ')}" data-key="${key}">${day}</button>`;
  }
  datePicker.innerHTML = `
    <div class="date-picker-header">
      <button type="button" data-nav="-12" title="${t('Previous year')}" aria-label="${t('Previous year')}">«</button>
      <button type="button" data-nav="-1" title="${t('Previous month')}" aria-label="${t('Previous month')}">‹</button>
      <span class="date-picker-title">${pickerMonthFormatter().format(first)}</span>
      <button type="button" data-nav="1" title="${t('Next month')}" aria-label="${t('Next month')}">›</button>
      <button type="button" data-nav="12" title="${t('Next year')}" aria-label="${t('Next year')}">»</button>
    </div>
    <div class="date-picker-grid">${cells}</div>
    <div class="date-picker-hint">${t('Click a day, then a second one for a range.')}</div>`;
}

function openDatePicker() {
  const fromDay = dateFilter ? Math.floor(dateFilter.from / 1000000) : null;
  const toDay = dateFilter ? Math.floor(dateFilter.to / 1000000) : null;
  const key = fromDay ?? latestPhotoDateKey() ?? todayDateKey();
  pickerYear = Math.floor(key / 10000);
  pickerMonth = (Math.floor(key / 100) % 100) - 1;
  pickStart = fromDay;
  pickEnd = fromDay !== null && toDay !== fromDay ? toDay : null;
  pickAwaitingEnd = false;
  datePicker.style.display = 'block';
  renderDatePicker();
  positionDatePicker();
}

function applyPickerSelection() {
  const low = Math.min(pickStart, pickEnd ?? pickStart);
  const high = Math.max(pickStart, pickEnd ?? pickStart);
  dateFilterInput.value = low === high ? String(low) : `${low}-${high}`;
  setDateFilterFromInput();
}

// 1er clic : jour unique (filtre appliqué tout de suite). 2e clic : plage, ou même jour pour valider le jour unique.
function pickDate(key) {
  if (!pickAwaitingEnd) {
    pickStart = key;
    pickEnd = null;
    pickAwaitingEnd = true;
    applyPickerSelection();
    renderDatePicker();
    return;
  }
  pickAwaitingEnd = false;
  if (key !== pickStart) {
    pickEnd = key;
    applyPickerSelection();
  }
  closeDatePicker();
}

datePicker.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (!button) return;
  if (button.dataset.nav) {
    const shifted = new Date(pickerYear, pickerMonth + Number(button.dataset.nav), 1);
    pickerYear = shifted.getFullYear();
    pickerMonth = shifted.getMonth();
    renderDatePicker();
    positionDatePicker();
  } else if (button.dataset.key) {
    pickDate(Number(button.dataset.key));
  }
});

dateFilterCalendar.addEventListener('click', () => {
  if (isDatePickerOpen()) closeDatePicker();
  else openDatePicker();
});

document.addEventListener('pointerdown', event => {
  if (!isDatePickerOpen()) return;
  const target = event.target;
  if (target instanceof Node && (datePicker.contains(target) || dateFilterCalendar.contains(target))) return;
  closeDatePicker();
}, true);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && isDatePickerOpen()) closeDatePicker();
});
window.addEventListener('resize', closeDatePicker);

// ==========================================
// MENU CONTEXTUEL DES MINIATURES (voir photo-actions.js)
// ==========================================
// Retire de l'affichage les photos dont le fichier vient d'être supprimé, sans recharger la bibliothèque ni remonter la grille.
// En mode comparaison (ou sélection multiple), les autres photos sélectionnées non supprimées sont conservées.
function removePhotosFromLibrary(paths, { keepSelection = false } = {}) {
  const removed = new Set(paths);
  if (removed.size === 0) return;
  const firstRemovedIndex = photos.findIndex(photo => removed.has(photo.path));

  // Conserve les autres photos sélectionnées qui n'ont pas été supprimées
  const remainingSelectedPaths = [...selectedIndices]
    .map(index => photos[index]?.path)
    .filter(path => path && !removed.has(path));
  const keptLastPath = !removed.has(photos[lastSelectedIndex]?.path) ? photos[lastSelectedIndex]?.path : null;

  for (const path of removed) thumbnailCacheLookups.delete(path);
  const treeSharesLibrary = folderTreePhotos === loadedPhotos;
  loadedPhotos = loadedPhotos.filter(photo => !removed.has(photo.path));
  folderTreePhotos = treeSharesLibrary ? loadedPhotos : folderTreePhotos.filter(photo => !removed.has(photo.path));
  fullscreenImageCache.clear();
  renderFolderTree();
  renderKeywordFilters();

  if (loadedPhotos.length === 0) {
    applyPhotoFilters(); // plus aucune photo : même traitement que des filtres sans résultat
    return;
  }

  photos = photos.filter(photo => !removed.has(photo.path));
  updateFilteredPhotosCount();

  for (const node of renderedThumbnailNodes.values()) node.remove();
  renderedThumbnailNodes.clear();
  selectedIndices.clear();

  // Si d'autres photos faisaient partie de la sélection (ex. comparaison de 4 photos dont une est supprimée),
  // on conserve les survivantes pour continuer la comparaison !
  if (remainingSelectedPaths.length > 0) {
    const indexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
    for (const path of remainingSelectedPaths) {
      if (indexByPath.has(path)) selectedIndices.add(indexByPath.get(path));
    }
    lastSelectedIndex = indexByPath.get(keptLastPath) ?? selectedIndices.values().next().value ?? 0;
  } else if (photos.length > 0) {
    lastSelectedIndex = Math.max(0, Math.min(firstRemovedIndex < 0 ? lastSelectedIndex : firstRemovedIndex, photos.length - 1));
    selectedIndices.add(lastSelectedIndex);
  } else {
    lastSelectedIndex = 0;
  }

  updateVirtualScroller();
  if (photos.length > 0) {
    updateUIOnSelection();
  } else {
    renderPreview();
    clearFullscreenImage();
    updateRatingAction();
  }
}

initPhotoActions({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  getActiveIndex: () => lastSelectedIndex,
  selectOnly: index => {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
    updateUIOnSelection();
  },
  removePhotos: removePhotosFromLibrary,
  showToast: showWriteToast,
  rescanFolder,
  folderCreated: addCreatedFolder,
  syncLibrary: () => { librarySyncNotBefore = 0; return syncLibraryWithDisk(); }, // nouveaux fichiers créés par l'application (redimensionnement)
  deleteFolder: deleteFolderToTrash,
});

// ==========================================
// SYNCHRONISATION AVEC LES MODIFICATIONS EXTERNES (ajouts, éditions, métadonnées, suppressions)
// ==========================================
// Lancée au démarrage et quand la fenêtre reprend le focus (on revient en général d'un autre programme après une édition) :
// aucun minuteur. Le backend compare taille et date de modification et ne relit que les fichiers concernés. Pour rester
// légère, l'intervalle minimal entre deux passages vaut 10 fois la durée du dernier (au moins 10 s).
const LIBRARY_SYNC_MIN_INTERVAL_MS = 10000;
let librarySyncRunning = false;
let librarySyncNotBefore = 0;

async function syncLibraryWithDisk() {
  if (librarySyncRunning || scanTasks.length > 0 || photoMoveRunning || Date.now() < librarySyncNotBefore) return;
  librarySyncRunning = true;
  const startedAt = Date.now();
  try {
    const changes = await invoke('sync_library');
    if (changes.added.length || changes.updated.length || changes.removed.length) await refreshLibraryAfterSync(changes);
  } catch (error) {
    console.debug('Synchronisation avec le disque impossible', error);
  } finally {
    librarySyncNotBefore = Date.now() + Math.max(LIBRARY_SYNC_MIN_INTERVAL_MS, (Date.now() - startedAt) * 10);
    librarySyncRunning = false;
  }
}

// Recharge la liste depuis la base sans remonter la grille ni perdre la sélection (retrouvée par chemin).
async function refreshLibraryAfterSync(changes) {
  const folderAtStart = currentFolderFilter;
  const known = new Map(loadedPhotos.map(photo => [photo.path, photo]));
  const modified = new Set(changes.updated);
  const query = folderFilter => invoke('get_photos_paginated', { offset: 0, limit: 50000, folderFilter, recursive: includeSubfolders });
  const [fresh, everything] = await Promise.all([query(folderAtStart), folderAtStart === null ? null : query(null)]);
  if (folderAtStart !== currentFolderFilter) return; // dossier changé pendant le chargement : le rechargement normal fait foi
  for (const photo of fresh) {
    const previous = known.get(photo.path);
    if (!previous || modified.has(photo.path)) continue;
    // Ratio et dimensions appris depuis les images : conservés pour ne pas redéclencher la disposition.
    if (previous.aspectRatio) photo.aspectRatio = previous.aspectRatio;
    if (previous.measuredWidth) { photo.measuredWidth = previous.measuredWidth; photo.measuredHeight = previous.measuredHeight; }
  }
  for (const path of modified) {
    photoVersions.set(path, Date.now());
    thumbnailCacheLookups.delete(path); // la miniature du cache change de nom avec la taille et la date du fichier
  }
  if (modified.size) {
    previewSignature = ''; // force le rechargement de l'aperçu
    fullscreenImageCache.clear();
  }
  loadedPhotos = fresh;
  folderTreePhotos = everything ?? fresh;
  renderFolderTree();
  renderKeywordFilters();
  applyPhotoFilters({ keepState: true });
}

window.addEventListener('focus', () => { syncLibraryWithDisk(); });

// DEMARRAGE

function restorePanelsVisibility() {
  const sidebarVisible = localStorage.getItem('sidebarVisible') !== 'false';
  const previewVisible = localStorage.getItem('previewVisible') !== 'false';
  const exifVisible = localStorage.getItem('exifVisible') !== 'false';

  // 1. Panneau latéral gauche
  sidebarPanel.classList.toggle('hidden', !sidebarVisible);
  document.getElementById('btn-toggle-sidebar')?.classList.toggle('active', sidebarVisible);
  if (sidebarVisible) {
    if (sidebarWidth > 0) sidebarPanel.style.width = `${sidebarWidth}px`;
  } else {
    sidebarPanel.style.removeProperty('width');
  }

  // 2. Panneau d'aperçu
  mainContent.classList.toggle('preview-hidden', !previewVisible);
  document.getElementById('btn-toggle-preview')?.classList.toggle('active', previewVisible);

  // 3. Panneau EXIF
  const exifPanel = document.getElementById('exif-panel');
  exifPanel?.classList.toggle('hidden', !exifVisible);
  document.getElementById('btn-toggle-exif')?.classList.toggle('active', exifVisible);
}

// Restauration de l'état des panneaux avant le chargement des photos
restorePanelsVisibility();

loadFolders();
refreshStorageLocationUI();
loadPhotos().then(() => setTimeout(syncLibraryWithDisk, 2000)); // délai : laisse d'abord se charger les premières miniatures

// ==========================================
// EMPLACEMENT DES DONNÉES ET DU CACHE
// ==========================================
async function refreshStorageLocationUI() {
  try {
    const info = await invoke('get_storage_location');
    const pathDisplay = document.getElementById('storage-path-display');
    const resetBtn = document.getElementById('btn-reset-storage');
    if (pathDisplay) {
      pathDisplay.textContent = info.current_path;
      pathDisplay.title = info.current_path;
    }
    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !info.is_custom);
    }
  } catch (error) {
    console.error("Lecture de l'emplacement de stockage impossible", error);
  }
}

document.getElementById('btn-change-storage')?.addEventListener('click', async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: t('Choose data folder'),
  });
  if (!selected) return;

  showTaskToast(t('Moving data and cache…'), 50);
  try {
    await invoke('change_storage_location', { newPath: selected });
    await refreshStorageLocationUI();
    showWriteToast(t('Data location updated successfully'));
    loadPhotos();
  } catch (error) {
    console.error('Changement de dossier impossible', error);
    showWriteToast(t('Error moving data: {error}', { error: String(error) }));
  } finally {
    hideTaskToast();
  }
});

document.getElementById('btn-reset-storage')?.addEventListener('click', async () => {
  showTaskToast(t('Moving data and cache…'), 50);
  try {
    await invoke('change_storage_location', { newPath: null });
    await refreshStorageLocationUI();
    showWriteToast(t('Data location updated successfully'));
    loadPhotos();
  } catch (error) {
    console.error('Réinitialisation impossible', error);
    showWriteToast(t('Error moving data: {error}', { error: String(error) }));
  } finally {
    hideTaskToast();
  }
});