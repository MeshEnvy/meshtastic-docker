# syntax=docker/dockerfile:1
# BuildKit is required for cache mounts (enabled automatically by build.js)
# Cache mounts persist PlatformIO packages across builds to avoid re-downloading

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONHTTPSVERIFY=1
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Install system dependencies
RUN apt-get update && \
    apt-get install -y git curl python3 python3-pip python3-venv ca-certificates && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install PlatformIO (it installs its own Python in ~/.platformio/python)
RUN curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py -o get-platformio.py && \
    python3 get-platformio.py && \
    rm get-platformio.py

# Add PlatformIO to PATH
ENV PATH="/root/.platformio/penv/bin:$PATH"

# Update certifi in PlatformIO's Python environment to fix SSL issues
RUN /root/.platformio/penv/bin/pip install --upgrade certifi requests urllib3

# Build argument for Meshtastic version tag
ARG MESHTASTIC_VERSION

# Clone the Meshtastic firmware repository at the specified tag
RUN git clone --branch ${MESHTASTIC_VERSION} --depth 1 https://github.com/meshtastic/firmware.git /meshtastic

# Set working directory
WORKDIR /meshtastic

# Initialize submodules
RUN git submodule update --init

# Install PlatformIO project dependencies with caching
# Cache only packages and tools subdirectories (not the entire .platformio to preserve penv)
# Cache project .pio directory for build artifacts (shared for same version)
RUN --mount=type=cache,target=/root/.platformio/packages,id=pio-packages-${MESHTASTIC_VERSION},sharing=shared \
    --mount=type=cache,target=/root/.platformio/tools,id=pio-tools-${MESHTASTIC_VERSION},sharing=shared \
    --mount=type=cache,target=/meshtastic/.pio,id=meshtastic-pio-${MESHTASTIC_VERSION},sharing=shared \
    # Install packages (they'll be written to cache mounts)
    pio pkg install || \
    (echo "Retrying package install..." && sleep 10 && pio pkg install) || \
    (echo "Final retry..." && sleep 20 && pio pkg install)

