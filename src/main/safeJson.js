// JSON files that must survive a crash or a kill mid-write (the dev build is
// restarted on every source change): written to a temp file, then renamed
// over the real one, keeping the previous good copy as <file>.bak. Reading
// falls back to that copy when the file is damaged, and keeps the damaged
// file aside (<file>.corrupt-<time>) instead of letting it be overwritten.
import fs from 'fs'

export function writeJsonSafe(file, data) {
  const text = JSON.stringify(data, null, 2)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  } catch {
    // no backup this time; the new file is still written safely
  }
  fs.renameSync(tmp, file)
}

// -> { data, from: 'file' | 'backup' | null, corrupt: path | null }
export function readJsonSafe(file) {
  let corrupt = null
  if (fs.existsSync(file)) {
    try {
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')), from: 'file', corrupt }
    } catch {
      corrupt = `${file}.corrupt-${Date.now()}`
      try {
        fs.copyFileSync(file, corrupt)
      } catch {
        corrupt = null
      }
    }
  }
  const bak = `${file}.bak`
  if (fs.existsSync(bak)) {
    try {
      return { data: JSON.parse(fs.readFileSync(bak, 'utf8')), from: 'backup', corrupt }
    } catch {
      // the backup is damaged too
    }
  }
  return { data: null, from: null, corrupt }
}
