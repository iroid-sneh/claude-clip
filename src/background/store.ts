// ─────────────────────────────────────────────────────────────────────────
// IndexedDB persistence. The MV3 service worker can be evicted mid-recording,
// so the live Session is written continuously and reloaded on wake.
// ─────────────────────────────────────────────────────────────────────────

import { openDB, type IDBPDatabase } from 'idb'
import type { FrameBundle, Session } from '@/shared/types'

const DB_NAME = 'claude-clip'
const DB_VERSION = 3
const SESSION_STORE = 'sessions'
const VIDEO_STORE = 'videos'
const FRAME_STORE = 'frames'
const ACTIVE_KEY = 'active-session-id'

export interface VideoRecord {
  id: string // sessionId
  blob: Blob
  mimeType: string
  durationMs: number
  hasAudio: boolean
  createdAt: number
}

let dbPromise: Promise<IDBPDatabase> | null = null

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(SESSION_STORE)) {
          database.createObjectStore(SESSION_STORE, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(VIDEO_STORE)) {
          database.createObjectStore(VIDEO_STORE, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(FRAME_STORE)) {
          database.createObjectStore(FRAME_STORE, { keyPath: 'id' })
        }
      },
    })
  }
  return dbPromise
}

export async function saveVideo(record: VideoRecord): Promise<void> {
  const d = await db()
  await d.put(VIDEO_STORE, record)
}

export async function loadVideo(id: string): Promise<VideoRecord | undefined> {
  const d = await db()
  return d.get(VIDEO_STORE, id)
}

export async function saveFrames(bundle: FrameBundle): Promise<void> {
  const d = await db()
  await d.put(FRAME_STORE, bundle)
}

export async function loadFrames(id: string): Promise<FrameBundle | undefined> {
  const d = await db()
  return d.get(FRAME_STORE, id)
}

export async function saveSession(session: Session): Promise<void> {
  const d = await db()
  await d.put(SESSION_STORE, session)
}

export async function loadSession(id: string): Promise<Session | undefined> {
  const d = await db()
  return d.get(SESSION_STORE, id)
}

export async function listSessions(): Promise<Session[]> {
  const d = await db()
  const all = (await d.getAll(SESSION_STORE)) as Session[]
  return all.sort((a, b) => b.startedAt - a.startedAt)
}

/** Delete a session and all of its artifacts (video + frames). */
export async function deleteSession(id: string): Promise<void> {
  const d = await db()
  await Promise.all([
    d.delete(SESSION_STORE, id),
    d.delete(VIDEO_STORE, id),
    d.delete(FRAME_STORE, id),
  ])
}

// The active-session id lives in chrome.storage.session (fast, ephemeral) so a
// freshly-woken worker knows which persisted Session to resume.
export async function setActiveSessionId(id: string | null): Promise<void> {
  if (id === null) {
    await chrome.storage.session.remove(ACTIVE_KEY)
  } else {
    await chrome.storage.session.set({ [ACTIVE_KEY]: id })
  }
}

export async function getActiveSessionId(): Promise<string | null> {
  const res = await chrome.storage.session.get(ACTIVE_KEY)
  return (res[ACTIVE_KEY] as string) ?? null
}
