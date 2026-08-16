
# Setting Up Stereolabs ZED SDK with CUDA on Ubuntu 22.04 PREEMPT_RT Realtime Kernel

Andy Wang

This guide outlines the successful procedure for installing the ZED SDK and the CUDA Toolkit on an Ubuntu 22.04 system running a real-time kernel, using the NVIDIA Open GPU Kernel Modules to maintain system stability.

## Prerequisites & Initial State

* Operating System: Fresh installation of Ubuntu 22.04 LTS.
* Kernel: Real-time kernel (PREEMPT_RT) enabled via Ubuntu Pro.

------------------------------

## Step 1: Purge Pre-existing Graphics Drivers

Remove any conflicting or corrupt proprietary NVIDIA drivers to clean the environment.

```bash
sudo apt purge *nvidia* *libnvidia*
sudo apt autoremove
```

## Step 2: Identify and Install Open-Source NVIDIA Driver

Query the package manager for the recommended hardware driver matching your GPU architecture.

```bash
ubuntu-drivers devices
```

Install the recommended open-flavor driver, rebuild your initramfs partition, and restart the host machine.

```bash
sudo apt install nvidia-driver-595-open
sudo update-initramfs -u
sudo reboot
```

## Step 3: Validate Kernel and Driver Integrity

After rebooting, execute health checks to verify that the real-time kernel successfully loaded the open-source DKMS graphics module flavor.

```bash
# Verify real-time kernel status
uname -r

# Confirm DKMS compilation success
sudo dkms status

# Check current driver and supported CUDA capabilities
nvidia-smi

# Confirm the active module type is Open Source
sudo dmesg | grep -i "open"
```

(Look for: NVRM: loading NVIDIA UNIX Open Kernel Module...)

## Step 4: Install ZED SDK (With Environment Protections)

Download the Ubuntu 22.04 ZED SDK installer matching your configuration. Run it in silent mode with explicit flags to bypass the default package management overrides that could corrupt your real-time driver setup.

```bash
chmod +x ZED_SDK_Ubuntu22_v*.run
./ZED_SDK_Ubuntu22_v*.run -- silent skip_cuda
```

## Step 5: Manually Deploy the CUDA Toolkit Archive

To prevent package conflicts, pull the standalone `.run` installer from the official NVIDIA CUDA Toolkit Archive instead of installing via standard apt repositories.

```bash
# 1. Download the runfile installer for your Ubuntu version from the
#    NVIDIA CUDA Toolkit Archive:
#    https://developer.nvidia.com/cuda-toolkit-archive
#    (the example version below matches the nvidia-driver-595-open
#    driver installed in Step 2)
CUDA_RUNFILE=cuda_13.2.0_595.84_linux.run

# 2. Execute the runfile setup script
sudo sh "$CUDA_RUNFILE"
```


* Step 5a: Choose Continue when prompted with the package manager warning.
* Step 5b: Inside the visual menu, use the spacebar to uncheck "Driver". Ensure only "CUDA Toolkit" is selected, navigate down, and select Install.

## Step 6: Configure System-Wide Shared Library Cache Paths

Bind the newly isolated CUDA Runtime library directories to the Ubuntu shared library path system.

```bash
echo "/usr/local/cuda-13.2/lib64" | sudo tee /etc/ld.so.conf.d/cuda-13-2.conf
sudo ldconfig
```

## Step 7: Launch Verification

Run the ZED developer tool executable to verify structural rendering and hardware connectivity.

```bash
ZED_Explorer
```

