# meshtastic-docker

A 100% off-grid Meshtastic build environment using Docker. This project creates version-tagged Docker images with all PlatformIO dependencies pre-installed and cached, enabling reproducible builds without requiring internet access during the build process.

## Overview

This project solves the problem of building Meshtastic firmware in isolated or offline environments by:

- **Pre-baking all dependencies** into Docker images tagged by Meshtastic version
- **Caching PlatformIO packages** using Docker BuildKit cache mounts for faster rebuilds
- **Version-tagged images** that can be stored, shared, or used offline
- **Reproducible builds** - the same version always produces the same image

Once built, these Docker images contain everything needed to compile Meshtastic firmware without any network access, making them perfect for:
- Air-gapped development environments
- CI/CD pipelines with limited internet access
- Reproducible builds across different machines
- Offline firmware development

## Prerequisites

- Docker (with BuildKit support) or Podman
- Node.js/Bun (for build scripts)
- Git (with the firmware submodule initialized)

## Setup

1. **Clone the repository with submodules:**
   ```bash
   git clone --recursive <repository-url>
   cd meshtastic-docker
   ```

   Or if already cloned:
   ```bash
   git submodule update --init --recursive
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Build your first image:**
   ```bash
   bun run build latest
   ```

## Usage

### Building Images

Build the latest Meshtastic version:
```bash
bun run build latest
```

Build a specific version:
```bash
bun run build 2.7.16
```

Build multiple versions matching a semver range:
```bash
bun run build ">2.5.0"
```

### Advanced Options

**Cache busting** - Force rebuild from a specific point:
```bash
bun run build latest --cache-bust 12345
```

**Cache cleanup** - Remove broken cache entries before building:
```bash
bun run build latest --cache-clean /root/.platformio/packages/framework-arduinoespressif32/.piopm
```

Multiple cleanup paths:
```bash
bun run build latest \
  --cache-clean /root/.platformio/packages/framework-arduinoespressif32/.piopm \
  --cache-clean /root/.platformio/packages/framework-arduinoespressif32
```

**Get help:**
```bash
bun run build --help
```

### Using Built Images

**Open a bash shell** in the latest built image:
```bash
bun run bash
```

**Open a bash shell** in a specific version:
```bash
bun run bash 2.7.16
```

**Build firmware** inside the container:
```bash
docker run --rm -it -v $(pwd)/output:/output meshtastic-docker:v2.7.16-1 \
  pio run --environment tbeam -f bin -o firmware.bin
```

## How It Works

1. **Dependency Installation**: The Dockerfile installs PlatformIO and all required packages, caching them using BuildKit cache mounts
2. **Version Tagging**: Images are tagged as `meshtastic-docker:v{VERSION}-{BUILD_NUM}` (e.g., `meshtastic-docker:v2.7.16-1`)
3. **Cache Management**: BuildKit cache mounts persist PlatformIO packages, tools, and cache across builds
4. **Offline Capability**: Once built, images contain all dependencies and can be used without internet access

## Image Structure

Each image contains:
- Ubuntu 22.04 base
- PlatformIO Core with Python environment
- Meshtastic firmware repository at the specified version tag
- All PlatformIO packages and tools pre-installed
- Build environment ready to compile firmware

## Network Requirements

**Note:** Building works better over a VPN. Some residential internet providers (such as Spectrum) mark certain PlatformIO mirrors as 'suspicious', which can cause package fetches to fail. Using a VPN typically resolves these connectivity issues.

The initial build requires internet access to download PlatformIO packages. Subsequent builds reuse cached packages, and once built, images work completely offline.

## Troubleshooting

**"No space left on device" errors:**
- Clean Docker build cache: `docker builder prune -a`
- Increase Docker disk allocation in Docker Desktop settings

**Broken cache entries:**
- Use `--cache-clean` to remove specific broken paths
- Or invalidate cache from a point: `--cache-bust <value>`

**SSL errors from PlatformIO mirrors:**
- Use a VPN (see Network Requirements above)
- The build script includes retry logic for transient failures

## Project Structure

```
meshtastic-docker/
├── Dockerfile          # Docker image definition
├── build.js            # Build script with version management
├── bash.js             # Script to open shells in built images
├── package.json        # Node.js dependencies
└── firmware/           # Meshtastic firmware submodule
```

## License

[Add your license here]
