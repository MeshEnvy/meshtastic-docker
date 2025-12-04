import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import semver from 'semver'

const execAsync = promisify(exec)

const IMAGE_NAME = 'meshtastic-docker'
const CONTAINER_RUNTIME = 'docker'

async function fetchTags() {
  try {
    const { stdout } = await execAsync('git -C firmware tag --sort=-version:refname')
    const tags = stdout.split('\n').filter((tag) => tag.trim().length > 0)
    return tags
  } catch (error) {
    console.error('Error fetching tags from firmware submodule:', error.message)
    throw new Error('Failed to fetch tags from firmware submodule. Make sure the submodule is initialized.')
  }
}

function getAllValidVersions(tags) {
  const validVersions = tags
    .map((tag) => {
      let version = tag.replace(/^v/, '')
      const versionMatch = version.match(/^(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/)
      if (versionMatch) {
        version = versionMatch[1]
      }
      return { tag, version }
    })
    .filter(({ version }) => semver.valid(version))
    .sort((a, b) => semver.compare(b.version, a.version))

  return validVersions
}

function getLatestTag(tags) {
  const validVersions = getAllValidVersions(tags)
  return validVersions.length > 0 ? validVersions[0] : null
}

async function findImageForVersion(version) {
  try {
    const { stdout } = await execAsync(`${CONTAINER_RUNTIME} images --format "{{.Repository}}:{{.Tag}}" ${IMAGE_NAME}`)
    const images = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const match = line.match(/^meshtastic-docker:v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)-(\d+)$/)
        if (match) {
          return { image: line, version: match[1], buildNum: parseInt(match[2], 10) }
        }
        return null
      })
      .filter((img) => img !== null)
      .sort((a, b) => {
        const versionCompare = semver.compare(b.version, a.version)
        if (versionCompare !== 0) return versionCompare
        return b.buildNum - a.buildNum
      })

    if (version) {
      const matching = images.find((img) => img.version === version)
      return matching ? matching.image : null
    }

    return images.length > 0 ? images[0].image : null
  } catch (error) {
    return null
  }
}

async function main() {
  const versionArg = process.argv[2]

  let imageToUse

  if (versionArg) {
    // User specified a version - find or build that specific version
    console.log(`Looking for image with version ${versionArg}...`)
    imageToUse = await findImageForVersion(versionArg)

    if (!imageToUse) {
      console.log(`Image not found for version ${versionArg}. Building it now...`)
      // Import and use build logic to build this specific version
      const { execSync } = await import('child_process')
      execSync(`bun run build ${versionArg}`, { stdio: 'inherit' })
      imageToUse = await findImageForVersion(versionArg)
      if (!imageToUse) {
        console.error(`Failed to build or find image for version ${versionArg}`)
        process.exit(1)
      }
    }
  } else {
    // No version specified - use latest
    console.log('Finding latest version...')
    const tags = await fetchTags()
    const latest = getLatestTag(tags)

    if (!latest) {
      console.error('No valid semver tags found')
      process.exit(1)
    }

    console.log(`Latest version: ${latest.version} (tag: ${latest.tag})`)
    imageToUse = await findImageForVersion(latest.version)

    if (!imageToUse) {
      console.log(`Image not found for latest version ${latest.version}. Building it now...`)
      const { execSync } = await import('child_process')
      execSync('bun run build latest', { stdio: 'inherit' })
      imageToUse = await findImageForVersion(latest.version)
      if (!imageToUse) {
        console.error(`Failed to build or find image for version ${latest.version}`)
        process.exit(1)
      }
    }
  }

  console.log(`Opening bash shell in ${imageToUse}...`)
  console.log('(Type "exit" to leave the container)')

  // Run interactive bash shell
  const dockerProcess = spawn(CONTAINER_RUNTIME, ['run', '-it', '--rm', imageToUse, 'bash'], {
    stdio: 'inherit',
  })

  dockerProcess.on('close', (code) => {
    process.exit(code || 0)
  })

  dockerProcess.on('error', (error) => {
    console.error(`Failed to run container:`, error.message)
    process.exit(1)
  })
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
