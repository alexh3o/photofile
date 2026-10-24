# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *feat*: add **total photo quantity** as well as quantity per root folder and drive" in "About" screen
- [x] *feat*: `UI`memorize open panels when closing app, reopen them + thumbnails
- [x] *feat*: `UI`darken non selected photos when hovering over selection
- [x] *feat*: **search by filename**
- [ ] *style*: `UI`add **UI/text size** setting
  => set text types
- [x] *feat*: `UI` hotkey to display shortcuts guide
- [x] *feat*: `UI`add **optional displays on full screen** (filename, date, exif, rank)
- [ ] *fix*: `UI` **resizing app window to a small size** does not go well. Panels become narrow & unreadable while thumbnails keep their width.
  => set a minimal size for window and for each panel
- [ ] *fix*: **adding two folders** while first one is still scanning queues them but the name of the last one is displayed with first one's completion percentage
  => do not overlay toasts, put last action on hold

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: `UI`add selection panel close button, to close panel and deselect all pictures
- [x] *feat*: allow **stopping a running scan**
- [x] *style*: `UI` make **filters more compact**
- [x] *feat*: `UI` **click on a keyword to search** that keyword, ctrl modifier to add it to the searched keywords
- [x] *feat*: `UI` **shortcuts** for left panel, info panel
- [ ] *feat*: `UI`action & **shortcuts** to **toggle toolbar**
- [x] *style*: `UI` **remember window position and size** through restarts
- [ ] *feat*: `Controls` **keyboard shortcuts** customizing
- [ ] *feat*: `Controls` "**Open with**" keyboard shortcuts
- [ ] *perf*: add more **photos to cache** to improve felt full screen navigation speed
- [ ] *feat*: `UI` add **zoom value** display (optional)
- [x] *chore*: Add **Linux** release
  - [ ] *fix*: **No trash** available (but it mentions deletion is definitive)
  - [ ] *fix*: **Cannot move window** by title bar
  - [ ] *revert*: non working fix for "cannot move window by title bar"
  - [ ] **Test** linux release
- [ ] *feat*: Allow **keywords management & file write** (HARD)
  - [ ] Implement **tree structure** matching **existing pictures**, handle **active/inactive keywords** in each branch, implement vizualisation **per picture, per pictures & collection**
  - [ ] Allow **adding keyword** in tree
  - [ ] Allow adding and removing keywords, writing files in all existing formats
  - [ ] Handle **multiplicity of tags** in structure
- [ ] *feat*: Add **mouse settings** screen

## ⚖️ Undecided

- [x] *feat*: **heic / heif** image format support
- [ ] *feat*: [HARD] **Face recognition** (heavy & unlikely)
- [ ] *feat*: jpeg **integrity scan** (specific view)
- [ ] *feat*: `needs_internet` **Map screen**
- [ ] *feat*: `needs_internet` add a **map widget** in info panel
- [ ] *feat*: `needs_internet` check and inform of **available update** on github (on hold, needs official releases)

## ❌ Not planned (use "Open with...")

- [ ] **Image editing**, cropping...

## 🧪 To be tested & potential bugs to be confirmed

- [ ] Test Linux Release
- [ ] Ensure moving files is safe
- [ ] Ensure writing files is safe
- [ ] Restoring data from data folder
- [ ] *fix*: thumbnails size setting doesn't persist through update
