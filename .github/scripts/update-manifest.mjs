#!/usr/bin/env node
// Writes the files Scout reads to find out whether there is a newer version.
//
//   updates/builds/<tag>.json   what a build produced. Immutable, the record.
//   updates/beta.json           George and Jose. Every build lands here.
//   updates/stable.json         everyone else. Only the "Release to everyone"
//                               workflow writes this.
//
// These are plain files in this repository's git tree, deliberately. The
// Scout 1 fleet still auto-updates by reading latest*.yml from whatever
// release is "latest" here (pinned to v3.6.0), and `gh release create` claims
// "latest" unless --latest=false is remembered every single time. A publishing
// path that CANNOT create or edit a release is safer than one that merely
// remembers not to.
//
// Node 20 on ubuntu-latest. No dependencies, no npm install.
//
//   node update-manifest.mjs record
//   node update-manifest.mjs promote --tag v5.2.0 --channel stable --rollout 100
//   node update-manifest.mjs backfill --tag v5.1.0

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const SCHEMA = 1
const UPDATES = 'updates'
const MANIFEST_BASE =
  'https://raw.githubusercontent.com/Orage-Agency/Scout-Releases/main/updates'

const die = (m) => {
  console.error(`::error::${m}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Version precedence, to Semantic Versioning 2.0.0 §11.
//
// The trap: numeric prerelease identifiers compare NUMERICALLY, so alpha.13
// is newer than alpha.2. A plain string compare says the opposite, and would
// quietly strand every beta tester on .9. The Dart client has the same rules
// and the same tests; if you change one, change both.
// ---------------------------------------------------------------------------
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(String(v).trim())
  if (!m) return null
  return {
    n: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

function cmp(a, b) {
  const A = parse(a)
  const B = parse(b)
  if (!A) die(`not a version: ${a}`)
  if (!B) die(`not a version: ${b}`)
  for (let i = 0; i < 3; i++) if (A.n[i] !== B.n[i]) return A.n[i] - B.n[i]
  // A release outranks any prerelease of the same numbers.
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1
  if (!B.pre.length) return -1
  const len = Math.max(A.pre.length, B.pre.length)
  for (let i = 0; i < len; i++) {
    if (i >= A.pre.length) return -1
    if (i >= B.pre.length) return 1
    const x = A.pre[i]
    const y = B.pre[i]
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (nx !== ny) {
      return nx ? -1 : 1 // numeric ranks below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------

const readJson = (p, fallback = null) =>
  existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback

function writeJson(path, value) {
  const text = JSON.stringify(value, null, 2) + '\n'
  // Round-trip before writing. A manifest that does not parse would break the
  // update check for every client at once, and nothing else would notice.
  JSON.parse(text)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  console.log(`wrote ${path}`)
}

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const notes = () => {
  const f = process.env.NOTES_FILE
  return f && existsSync(f) ? readFileSync(f, 'utf8').trim() : ''
}

const assetUrl = (repo, tag, name) =>
  `https://github.com/${repo}/releases/download/${tag}/${name}`

const pageUrl = (repo, tag) => `https://github.com/${repo}/releases/tag/${tag}`

function checkEntry(platform, e) {
  if (!e) die(`${platform} entry is missing`)
  if (!parse(e.version)) die(`${platform} version is not a version: ${e.version}`)
  if (!/^[0-9a-f]{64}$/.test(e.sha256 || '')) {
    die(`${platform} sha256 is not 64 hex characters`)
  }
  if (!Number.isInteger(e.size) || e.size <= 0) {
    die(`${platform} size is not a positive whole number`)
  }
  if (!String(e.url || '').startsWith('https://github.com/')) {
    die(`${platform} url is not a GitHub download: ${e.url}`)
  }
}

// ---- record: called by every build ----------------------------------------

function record() {
  const tag = process.env.TAG || die('TAG is not set')
  const repo = process.env.REPO || die('REPO is not set')
  const version = tag.replace(/^v/, '')
  if (!parse(version)) die(`the tag is not a version: ${tag}`)

  const buildPath = join(UPDATES, 'builds', `${tag}.json`)
  const build = readJson(buildPath, { schema: SCHEMA, tag, platforms: {} })
  build.schema = SCHEMA
  build.tag = tag
  build.sourceCommit = process.env.SOURCE_SHA || build.sourceCommit || ''
  build.platforms ||= {}

  const common = {
    version,
    tag,
    releasedAt: new Date().toISOString(),
    sourceCommit: build.sourceCommit,
    notes: notes(),
    pageUrl: pageUrl(repo, tag),
  }

  if (process.env.MAC_RESULT === 'success' && process.env.MAC_ZIP_SHA256) {
    if (process.env.MAC_UNIVERSAL !== 'yes') {
      // Not a hard failure: the release page still has the files for a manual
      // download. It just must never be offered as an automatic update.
      console.log('::warning::Skipping macOS in the manifest: this build is not universal.')
    } else {
      build.platforms.macos = {
        ...common,
        universal: true,
        url: assetUrl(repo, tag, 'scout-macos.zip'),
        sha256: process.env.MAC_ZIP_SHA256,
        size: Number(process.env.MAC_ZIP_SIZE),
      }
      checkEntry('macos', build.platforms.macos)
    }
  }

  if (process.env.WIN_RESULT === 'success' && process.env.WIN_SETUP_SHA256) {
    build.platforms.windows = {
      ...common,
      url: assetUrl(repo, tag, 'scout-windows-setup.exe'),
      sha256: process.env.WIN_SETUP_SHA256,
      size: Number(process.env.WIN_SETUP_SIZE),
    }
    checkEntry('windows', build.platforms.windows)
  }

  if (!Object.keys(build.platforms).length) {
    die('this run produced nothing to record')
  }
  writeJson(buildPath, build)

  // Every build goes to beta, per platform, and only ever forwards.
  // `>=` rather than `>` so re-running a platform onto the same tag refreshes
  // its checksum, while an older tag can never drag beta backwards.
  const betaPath = join(UPDATES, 'beta.json')
  const beta = readJson(betaPath, emptyChannel('beta'))
  beta.schema = SCHEMA
  beta.channel = 'beta'
  beta.rollout = 100
  beta.manifestUrl = `${MANIFEST_BASE}/beta.json`
  beta.platforms ||= {}
  for (const [platform, entry] of Object.entries(build.platforms)) {
    const current = beta.platforms[platform]
    if (current && cmp(entry.version, current.version) < 0) {
      console.log(
        `beta keeps ${platform} on ${current.version}; ${entry.version} is older`,
      )
      continue
    }
    beta.platforms[platform] = entry
    console.log(`beta ${platform} -> ${entry.version}`)
  }
  beta.generatedAt = new Date().toISOString()
  writeJson(betaPath, beta)
}

const emptyChannel = (channel) => ({
  schema: SCHEMA,
  channel,
  // 0 means "offer this to nobody", which is the right reading of a channel
  // that has never been published to.
  rollout: 0,
  manifestUrl: `${MANIFEST_BASE}/${channel}.json`,
  platforms: {},
})

// ---- promote: the "Release to everyone" button ----------------------------

function promote() {
  const tag = arg('tag') || die('--tag is required')
  const channel = arg('channel', 'stable')
  const rolloutRaw = arg('rollout', '100')
  const rollout = Number(rolloutRaw)
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
    die(`rollout must be a whole number from 0 to 100, not "${rolloutRaw}"`)
  }

  const build = readJson(join(UPDATES, 'builds', `${tag}.json`))
  if (!build) {
    die(`No build record for ${tag}. Build it first, or run backfill on it.`)
  }
  for (const platform of ['macos', 'windows']) {
    checkEntry(platform, build.platforms?.[platform])
  }
  if (build.platforms.macos.universal !== true) {
    die(`${tag}'s Mac build is not universal; it would not run on an Intel Mac.`)
  }

  const out = {
    schema: SCHEMA,
    channel,
    generatedAt: new Date().toISOString(),
    manifestUrl: `${MANIFEST_BASE}/${channel}.json`,
    rollout,
    platforms: build.platforms,
  }
  // Release notes are re-read at promotion, not frozen at build time, so they
  // can be tidied on the release page right up until the button is pressed.
  const fresh = notes()
  if (fresh) {
    for (const p of Object.values(out.platforms)) p.notes = fresh
  }
  writeJson(join(UPDATES, `${channel}.json`), out)
  console.log(
    rollout === 0
      ? `${channel} is PAUSED: nobody will be offered an update.`
      : `${channel} -> ${tag}`,
  )
}

// ---- backfill: give an already-published tag a build record ---------------

async function backfill() {
  const tag = arg('tag') || die('--tag is required')
  const repo = process.env.REPO || die('REPO is not set')
  const version = tag.replace(/^v/, '')
  if (!parse(version)) die(`the tag is not a version: ${tag}`)

  const build = { schema: SCHEMA, tag, sourceCommit: '', platforms: {} }
  const common = {
    version,
    tag,
    releasedAt: new Date().toISOString(),
    notes: notes(),
    pageUrl: pageUrl(repo, tag),
  }

  const wanted = [
    ['macos', 'scout-macos.zip', { universal: true }],
    ['windows', 'scout-windows-setup.exe', {}],
  ]
  for (const [platform, name, extra] of wanted) {
    const url = assetUrl(repo, tag, name)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) die(`${url} answered ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    build.platforms[platform] = {
      ...common,
      ...extra,
      url,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    }
    checkEntry(platform, build.platforms[platform])
    console.log(`${name}: ${build.platforms[platform].sha256} (${bytes.length} bytes)`)
  }

  // A backfilled Mac build is marked universal on trust: these tags were built
  // before the workflow recorded it. Every tag from v5.1.0 on was universal —
  // check the run log before backfilling anything older.
  writeJson(join(UPDATES, 'builds', `${tag}.json`), build)
}

const mode = process.argv[2]
if (mode === 'record') record()
else if (mode === 'promote') promote()
else if (mode === 'backfill') await backfill()
else die(`unknown mode "${mode}" (record | promote | backfill)`)
