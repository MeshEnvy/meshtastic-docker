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

# Cache breaker - increment to invalidate cache from this point forward
ARG CACHE_BUST=1

# Install PlatformIO project dependencies with caching
# Cache packages, tools, .cache, and project .pio directories
# Shared cache across all versions - builds newest to oldest to maximize cache reuse
RUN --mount=type=cache,target=/root/.platformio/packages,id=pio-packages-shared,sharing=shared \
    --mount=type=cache,target=/root/.platformio/tools,id=pio-tools-shared,sharing=shared \
    --mount=type=cache,target=/root/.platformio/.cache,id=pio-cache-shared,sharing=shared \
    --mount=type=cache,target=/meshtastic/.pio,id=meshtastic-pio-shared,sharing=shared \
    # Install packages (they'll be written to cache mounts)
    pio pkg install || \
    (echo "Retrying package install..." && sleep 10 && pio pkg install) || \
    (echo "Final retry..." && sleep 20 && pio pkg install) && \
    # Copy packages and tools from cache mounts to image
    mkdir -p /root/.platformio-image-packages /root/.platformio-image-tools /root/.platformio-image-pio && \
    cp -r /root/.platformio/packages/* /root/.platformio-image-packages/ 2>/dev/null || true && \
    cp -r /root/.platformio/tools/* /root/.platformio-image-tools/ 2>/dev/null || true && \
    cp -r /meshtastic/.pio/* /root/.platformio-image-pio/ 2>/dev/null || true

# Move packages and tools to final location in image
RUN mkdir -p /root/.platformio && \
    mv /root/.platformio-image-packages /root/.platformio/packages 2>/dev/null || true && \
    mv /root/.platformio-image-tools /root/.platformio/tools 2>/dev/null || true && \
    mv /root/.platformio-image-pio /meshtastic/.pio 2>/dev/null || true

RUN pio run