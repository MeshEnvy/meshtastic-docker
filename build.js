import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import semver from 'semver'
import { Command } from 'commander'

const execAsync = promisify(exec)

// Constants
const BUILD_NUM = 1
const MIN_VERSION = '>2.5.0'
const REPO_OWNER = 'meshtastic'
const REPO_NAME = 'firmware'
const IMAGE_NAME = 'benallfree/meshtastic-docker'
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

function getLatestPatchPerMinor(versions) {
  // Group by major.minor and keep only the latest patch for each minor version
  // Versions are already sorted newest first, so first occurrence of each major.minor is the latest patch
  const seen = new Map()
  const result = []

  for (const { tag, version } of versions) {
    const parsed = semver.parse(version)
    if (!parsed) continue

    const minorKey = `${parsed.major}.${parsed.minor}`
    if (!seen.has(minorKey)) {
      seen.set(minorKey, true)
      result.push({ tag, version })
    }
  }

  return result
}

async function buildImage(tag, version, buildNum, cacheBust, cacheCleanup) {
  const imageTag = `v${version}-${buildNum}`
  const fullTag = `${IMAGE_NAME}:${imageTag}`
  const buildArgs = ['--build-arg', `MESHTASTIC_VERSION=${tag}`, '--build-arg', `CACHE_BUST=${cacheBust}`]
  if (cacheCleanup) {
    buildArgs.push('--build-arg', `CACHE_CLEANUP=${cacheCleanup}`)
  }

  console.log(`Building ${fullTag}...`)

  return new Promise((resolve) => {
    // Enable BuildKit for cache mounts
    const env = { ...process.env, DOCKER_BUILDKIT: '1' }
    const dockerProcess = spawn(CONTAINER_RUNTIME, ['build', ...buildArgs, '-t', `${fullTag}`, '.'], {
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

async function buildSequentially(versions, buildNum, cacheBust, cacheCleanup) {
  // Build sequentially (newest to oldest) so cache is shared and reused
  const results = []
  for (const { tag, version } of versions) {
    const result = await buildImage(tag, version, buildNum, cacheBust, cacheCleanup)
    results.push(result)
  }
  return results
}

async function main() {
  const program = new Command()

  program
    .name('build')
    .description('Build Meshtastic Docker images')
    .argument('[semver]', 'Semver filter (e.g., "latest", ">2.5.0")', 'latest')
    .option('--cache-bust <value>', 'Cache bust value (default: 1, use timestamp to invalidate cache)')
    .option('--all-patches', 'Build all patch versions, not just latest patch per minor version')
    .option(
      '--cache-clean <path>',
      'Path to clean from cache (can be used multiple times)',
      (value, previous) => {
        return previous ? [...previous, value] : [value]
      },
      []
    )
    .parse(process.argv)

  const semverArg = program.args[0] || 'latest'
  const cacheBust = program.opts().cacheBust || '1'
  const allPatches = program.opts().allPatches || false
  const cacheCleanupPaths = program.opts().cacheClean || []
  const cacheCleanup = cacheCleanupPaths.length > 0 ? cacheCleanupPaths.join(' ') : null

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

    // By default, keep only latest patch per minor version unless --all-patches is set
    if (!allPatches) {
      const beforeCount = filteredVersions.length
      filteredVersions = getLatestPatchPerMinor(filteredVersions)
      const afterCount = filteredVersions.length
      if (beforeCount > afterCount) {
        console.log(`Filtered to latest patch per minor version: ${afterCount} versions (from ${beforeCount})`)
      }
    } else {
      console.log('Building all patch versions (--all-patches flag set)')
    }
  }

  if (filteredVersions.length === 0) {
    console.log('No versions match the criteria. Exiting.')
    return
  }

  console.log(`Building ${filteredVersions.length} images sequentially (newest to oldest) with BUILD_NUM=${BUILD_NUM}`)
  console.log('Versions to build:', filteredVersions.map((v) => v.version).join(', '))
  console.log(`Cache bust value: ${cacheBust}`)
  if (cacheCleanup) {
    console.log(`Cache cleanup paths: ${cacheCleanup}`)
  }
  console.log('Using shared cache - each version will reuse packages from previous builds')

  const results = await buildSequentially(filteredVersions, BUILD_NUM, cacheBust, cacheCleanup)

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
