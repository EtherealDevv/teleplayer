import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Folder, Library, VideoItem } from '../../../shared/types'
import { cx, formatBytes, initialOf, normalizeSearch } from '../utils'
import { Icon } from './Icon'

interface SidebarProps {
  library: Library
  selectedFolder: string
  view: 'library' | 'settings'
  importing: number
  query: string
  onQueryChange: (value: string) => void
  onSelectFolder: (folderId: string) => void
  onOpenLibrary: () => void
  onOpenSettings: () => void
  onImport: () => void
  onCreateFolder: () => void
  onEditFolder: (folder: Folder) => void
  onDeleteFolder: (folder: Folder) => void
}

function matchesVideo(video: VideoItem, query: string): boolean {
  if (!query) return true
  return (
    normalizeSearch(video.title).includes(query) || normalizeSearch(video.name).includes(query)
  )
}

export function Sidebar({
  library,
  selectedFolder,
  view,
  importing,
  query,
  onQueryChange,
  onSelectFolder,
  onOpenLibrary,
  onOpenSettings,
  onImport,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder
}: SidebarProps): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const user = library.user
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Tu cuenta'
  const normalized = normalizeSearch(query)
  const searching = normalized.length > 0

  const matchingVideos = searching
    ? library.videos.filter((video) => matchesVideo(video, normalized))
    : library.videos
  const unfiledVideos = library.videos.filter((video) => !video.folderId)
  const unfiledMatches = searching
    ? unfiledVideos.filter((video) => matchesVideo(video, normalized))
    : unfiledVideos
  const unfiledCount = unfiledMatches.length

  const folderMatches = (folder: Folder): boolean => {
    if (!searching) return true
    if (normalizeSearch(folder.name).includes(normalized)) return true
    return library.videos.some(
      (video) => video.folderId === folder.id && matchesVideo(video, normalized)
    )
  }

  const visibleFolders = library.folders.filter(folderMatches)
  const noResults =
    searching && matchingVideos.length === 0 && visibleFolders.length === 0 && unfiledCount === 0

  useEffect(() => {
    if (!menuFor) return
    const close = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuFor(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuFor])

  const select = (folderId: string): void => {
    setMenuFor(null)
    onOpenLibrary()
    onSelectFolder(folderId)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Buscar en tu biblioteca"
          aria-label="Buscar vídeos"
          spellCheck={false}
        />
        {query ? (
          <button
            className="sidebar-search-clear"
            onClick={() => onQueryChange('')}
            aria-label="Borrar búsqueda"
          >
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-label">{searching ? 'Resultados' : 'Carpetas'}</div>

        <div className="folder-list">
          {!searching || matchingVideos.length > 0 ? (
            <div className="folder-row-wrap">
              <button
                className={cx(
                  'nav-item folder-nav',
                  view === 'library' && selectedFolder === 'all' && 'active'
                )}
                onClick={() => select('all')}
              >
                <span className="folder-nav-icon library">
                  <Icon name="movie" filled size={19} />
                </span>
                <span className="folder-nav-text">
                  <span className="folder-nav-name">Biblioteca</span>
                  <span className="folder-nav-meta">
                    {matchingVideos.length}{' '}
                    {matchingVideos.length === 1 ? 'vídeo' : 'vídeos'}
                  </span>
                </span>
                {searching ? <span className="folder-nav-count">{matchingVideos.length}</span> : null}
              </button>
            </div>
          ) : null}

          {unfiledCount > 0 ? (
            <div className="folder-row-wrap">
              <button
                className={cx(
                  'nav-item folder-nav',
                  view === 'library' && selectedFolder === 'none' && 'active'
                )}
                onClick={() => select('none')}
              >
                <span className="folder-nav-icon unfiled">
                  <Icon name="inbox" size={18} />
                </span>
                <span className="folder-nav-text">
                  <span className="folder-nav-name">Sin carpeta</span>
                  <span className="folder-nav-meta">
                    {unfiledCount} {unfiledCount === 1 ? 'vídeo' : 'vídeos'}
                  </span>
                </span>
              </button>
            </div>
          ) : null}

          {visibleFolders.map((folder) => {
            const folderVideos = library.videos.filter((video) => video.folderId === folder.id)
            const folderNameMatches =
              searching && normalizeSearch(folder.name).includes(normalized)
            const shownVideos = searching && !folderNameMatches
              ? folderVideos.filter((video) => matchesVideo(video, normalized))
              : folderVideos
            const active = view === 'library' && selectedFolder === folder.id
            return (
              <div className="folder-row-wrap" key={folder.id}>
                <button
                  className={cx('nav-item folder-nav', active && 'active')}
                  onClick={() => select(folder.id)}
                >
                  <span
                    className="folder-nav-icon"
                    style={{ '--folder-color': folder.color } as CSSProperties}
                  >
                    {folder.emoji}
                  </span>
                  <span className="folder-nav-text">
                    <span className="folder-nav-name">{folder.name}</span>
                    <span className="folder-nav-meta">
                      {shownVideos.length} {shownVideos.length === 1 ? 'vídeo' : 'vídeos'}
                    </span>
                  </span>
                  {searching ? <span className="folder-nav-count">{shownVideos.length}</span> : null}
                </button>
                <button
                  className="folder-more icon-btn small"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuFor((value) => (value === folder.id ? null : folder.id))
                  }}
                  aria-label={`Opciones de ${folder.name}`}
                >
                  <Icon name="more_horiz" size={18} />
                </button>
                {menuFor === folder.id ? (
                  <div className="folder-menu" ref={menuRef}>
                    <button
                      onClick={() => {
                        setMenuFor(null)
                        onEditFolder(folder)
                      }}
                    >
                      <Icon name="edit" size={19} /> Editar carpeta
                    </button>
                    <button
                      className="danger-text"
                      onClick={() => {
                        setMenuFor(null)
                        onDeleteFolder(folder)
                      }}
                    >
                      <Icon name="delete" size={19} /> Eliminar carpeta
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}

          {library.folders.length === 0 && !searching ? (
            <button className="empty-folders" onClick={onCreateFolder}>
              <Icon name="create_new_folder" size={20} />
              <span>Crea tu primera carpeta</span>
            </button>
          ) : null}

          {noResults ? (
            <div className="sidebar-empty">
              <Icon name="search_off" size={28} />
              <strong>Sin resultados</strong>
              <span>Prueba con otro título o carpeta.</span>
            </div>
          ) : null}
        </div>

        {!searching && library.folders.length > 0 ? (
          <button className="new-folder-btn" onClick={onCreateFolder}>
            <span className="new-folder-icon">
              <Icon name="add" size={18} />
            </span>
            Nueva carpeta
          </button>
        ) : null}
      </div>

      <button className="sidebar-fab" onClick={onImport} aria-label="Añadir vídeos" title="Añadir vídeos">
        <Icon name="add" size={24} />
      </button>

      <div className="sidebar-bottom">
        <div className="sidebar-storage">
          <Icon name="cloud" size={16} />
          <span>{formatBytes(library.totalSize)}</span>
          <span className="storage-sep">·</span>
          <span>
            {library.videos.length} {library.videos.length === 1 ? 'vídeo' : 'vídeos'}
          </span>
          {importing > 0 ? (
            <span className="sidebar-uploading">
              <span className="mini-spinner" /> {importing}
            </span>
          ) : null}
        </div>

        <button
          className={cx('nav-item settings-item', view === 'settings' && 'active')}
          onClick={onOpenSettings}
        >
          <span className="settings-row-icon">
            <Icon name="settings" filled={view === 'settings'} size={20} />
          </span>
          <span>Ajustes</span>
          <Icon name="chevron_right" className="chevron" size={18} />
        </button>

        <button className="side-user" onClick={onOpenSettings} title="Tu cuenta de Telegram">
          <span className="avatar">{initialOf(name)}</span>
          <span className="side-user-text">
            <strong>{name}</strong>
            <span>{user?.username ? `@${user.username}` : 'Telegram conectado'}</span>
          </span>
          <span className="online-dot" title="Conectado" />
        </button>
      </div>
    </aside>
  )
}
