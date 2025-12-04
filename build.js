import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import semver from 'semver'

const execAsync = promisify(exec)

// Constants
const BUILD_NUM = 1
const MAX_PARALLEL = 3
const MIN_VERSION = '>2.5.0'
const REPO_OWNER = 'meshtastic'
const REPO_NAME = 'firmware'
const IMAGE_NAME = 'meshtastic-docker'
// Container runtime: 'docker' or 'podman'
const CONTAINER_RUNTIME = 'docker'

async function fetchTags() {
  try {
    // Fetch tags from local firmware submodule, sorted by version (newest first)
    const { stdout } = await execAsync('git -C firmware tag --sort=-version:refname')
    const tags = stdout.split('\n').filter((tag) => tag.trim().length > 0)

    return tags
  } catch (error) {
    console.error('Error fetching tags from firmware submodule:', error.message)
    throw new Error('Failed to fetch tags from firmware submodule. Make sure the submodule is initialized.')
  }
}

function getAllValidVersions(tags) {
  // Tags are already sorted by git --sort=-version:refname (newest first)
  // Extract version part (tags may have hash appended like v1.2.47-abc123)
  const validVersions = tags
    .map((tag) => {
      // Remove 'v' prefix if present
      let version = tag.replace(/^v/, '')
      // Extract version part before any hash (hash typically starts with -g or just -)
      // Match semver pattern: major.minor.patch(-prerelease)?
      const versionMatch = version.match(/^(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/)
      if (versionMatch) {
        version = versionMatch[1]
      }
      return { tag, version }
    })
    .filter(({ version }) => semver.valid(version))
    // Sort descending (newest first): compare(b, a) means if b > a, b comes first
    .sort((a, b) => semver.compare(b.version, a.version))

  if (validVersions.length === 0 && tags.length > 0) {
    console.log('Warning: No valid semver tags found. Sample tags:', tags.slice(0, 5).join(', '))
  }

  return validVersions
}

function filterTagsBySemver(tags, minVersion) {
  const validVersions = getAllValidVersions(tags)
  return validVersions.filter(({ version }) => semver.satisfies(version, minVersion))
}

function getLatestTag(tags) {
  const validVersions = getAllValidVersions(tags)
  if (validVersions.length > 0) {
    // Debug: show top 10 versions to verify sorting
    console.log(
      'Top 10 versions found:',
      validVersions
        .slice(0, 10)
        .map((v) => `${v.version} (${v.tag})`)
        .join(', ')
    )
  }
  return validVersions.length > 0 ? [validVersions[0]] : []
}

async function buildImage(tag, version, buildNum) {
  const imageTag = `v${version}-${buildNum}`
  const fullTag = `${IMAGE_NAME}:${imageTag}`
  const buildArg = `MESHTASTIC_VERSION=${tag}`

  console.log(`Building ${fullTag}...`)

  return new Promise((resolve) => {
    // Enable BuildKit for cache mounts
    const env = { ...process.env, DOCKER_BUILDKIT: '1' }
    const dockerProcess = spawn(CONTAINER_RUNTIME, ['build', '--build-arg', `${buildArg}`, '-t', `${fullTag}`, '.'], {
      env,
    })

    dockerProcess.stdout.on('data', (data) => {
      process.stdout.write(data)
    })

    dockerProcess.stderr.on('data', (data) => {
      process.stderr.write(data)
    })

    dockerProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`✓ Successfully built ${fullTag}`)
        resolve({ version, imageTag, success: true })
      } else {
        console.error(`✗ Failed to build ${fullTag} (exit code: ${code})`)
        resolve({
          version,
          imageTag,
          success: false,
          error: `Exit code: ${code}`,
        })
      }
    })

    dockerProcess.on('error', (error) => {
      console.error(`✗ Failed to build ${fullTag}:`, error.message)
      resolve({ version, imageTag, success: false, error: error.message })
    })
  })
}

async function buildInBatches(versions, buildNum, maxParallel) {
  const results = []
  for (let i = 0; i < versions.length; i += maxParallel) {
    const batch = versions.slice(i, i + maxParallel)
    const batchPromises = batch.map(({ tag, version }) => buildImage(tag, version, buildNum))
    const batchResults = await Promise.all(batchPromises)
    results.push(...batchResults)
  }
  return results
}

async function main() {
  // Parse command-line argument (default to 'latest')
  const semverArg = process.argv[2] || 'latest'

  console.log('Fetching tags from firmware submodule...')
  const tags = await fetchTags()
  console.log(`Found ${tags.length} tags`)

  let filteredVersions
  if (semverArg === 'latest') {
    console.log('Building latest version only')
    filteredVersions = getLatestTag(tags)
    if (filteredVersions.length === 0) {
      console.log('No valid semver tags found. Sample tags:', tags.slice(0, 10).join(', '))
      return
    }
    console.log(`Latest version: ${filteredVersions[0].version} (tag: ${filteredVersions[0].tag})`)
  } else {
    console.log(`Filtering tags by semver: ${semverArg}`)
    filteredVersions = filterTagsBySemver(tags, semverArg)
    console.log(`Found ${filteredVersions.length} versions matching criteria`)
  }

  if (filteredVersions.length === 0) {
    console.log('No versions match the criteria. Exiting.')
    return
  }

  console.log(`Building ${filteredVersions.length} images with BUILD_NUM=${BUILD_NUM}, MAX_PARALLEL=${MAX_PARALLEL}`)
  console.log('Versions to build:', filteredVersions.map((v) => v.version).join(', '))

  const results = await buildInBatches(filteredVersions, BUILD_NUM, MAX_PARALLEL)

  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  console.log('\n=== Build Summary ===')
  console.log(`Successful: ${successful.length}`)
  console.log(`Failed: ${failed.length}`)

  if (failed.length > 0) {
    console.log('\nFailed builds:')
    failed.forEach(({ imageTag, error }) => {
      console.log(`  - ${imageTag}: ${error}`)
    })
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
