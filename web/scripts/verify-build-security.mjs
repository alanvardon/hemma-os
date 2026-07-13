import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'dist')
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt', '.xml'])
const forbiddenLiterals = [
  ['Supabase secret-key prefix', /sb_secret_[A-Za-z0-9_-]+/g],
  ['service-role environment name', /SUPABASE_SERVICE_ROLE_KEY/g],
  ['private-key material', /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/g],
  ['GitHub token prefix', /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g],
  ['GitHub fine-grained token prefix', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['AWS access-key prefix', /AKIA[0-9A-Z]{16}/g],
]
const jwtPattern = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g

function filesUnder(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

const files = filesUnder(root)
const findings = []
let scannedTextFiles = 0
let jwtCount = 0

if (!files.some((file) => file.endsWith('index.html'))) {
  findings.push('the build has no index.html')
}

for (const file of files) {
  if (file.endsWith('.map')) findings.push('a source-map file was emitted')
  if (!textExtensions.has(extname(file))) continue

  scannedTextFiles += 1
  const body = readFileSync(file, 'utf8')
  if (/sourceMappingURL\s*=/.test(body)) findings.push('a source-map reference was emitted')

  for (const [label, pattern] of forbiddenLiterals) {
    pattern.lastIndex = 0
    if (pattern.test(body)) findings.push(`${label} was emitted`)
  }

  for (const token of body.match(jwtPattern) ?? []) {
    jwtCount += 1
    const payload = decodeJwtPayload(token)
    if (payload?.role === 'service_role') {
      findings.push('a JWT with the service_role claim was emitted')
    }
  }
}

const uniqueFindings = [...new Set(findings)]
if (uniqueFindings.length > 0) {
  for (const finding of uniqueFindings) console.error(`FAIL: ${finding}`)
  process.exit(1)
}

console.log(
  `PASS: scanned ${scannedTextFiles} emitted text assets and ${jwtCount} JWT-like value(s); no privileged secret or source-map pattern was found.`,
)
