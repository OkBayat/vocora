#!/usr/bin/env python3
"""Explicit build-time installation of the optional local feedback tokenizer.

Requires CPython 3.11/3.12, a C/C++ compiler, CMake >=3.21 and Ninja.
Creates a new venv only; never downloads a model or changes a running service.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import venv

REQUIREMENTS = Path(__file__).resolve().parents[1] / "requirements-writing-feedback-tokenizer.txt"
CMAKE_ARGS = " ".join([
    "-DGGML_NATIVE=OFF", "-DGGML_CUDA=OFF", "-DGGML_METAL=OFF", "-DGGML_VULKAN=OFF",
    "-DGGML_RPC=OFF", "-DGGML_BLAS=OFF", "-DGGML_OPENMP=OFF", "-DGGML_AVX=OFF",
    "-DGGML_AVX2=OFF", "-DGGML_AVX512=OFF", "-DGGML_AVX_VNNI=OFF",
    "-DGGML_FMA=OFF", "-DGGML_F16C=OFF",
])


def build_plan(destination):
    destination = Path(destination)
    if not destination.is_absolute() or destination == Path("/") or destination.exists():
        raise ValueError("Choose an absolute, new virtual-environment directory")
    dependencies = [line.strip() for line in REQUIREMENTS.read_text().splitlines()
                    if line.strip() and not line.lstrip().startswith("#")]
    native = [line for line in dependencies if line.startswith("llama-cpp-python @ ")]
    if len(native) != 1:
        raise ValueError("Expected one checksum-pinned native source")
    binary = [line for line in dependencies if line not in native]
    if not all(re.fullmatch(r"[A-Za-z0-9_-]+==[0-9.]+", line) for line in binary):
        raise ValueError("All dependency versions must be exact")
    return destination, binary, native[0]


def provision(destination):
    destination, dependencies, native = build_plan(destination)
    if sys.implementation.name != "cpython" or sys.version_info[:2] not in {(3, 11), (3, 12)}:
        raise ValueError("The initial build supports CPython 3.11 and 3.12")
    for command in ["cmake", "ninja", "cc", "c++"]:
        if not shutil.which(command):
            raise ValueError(f"Required build command is missing: {command}")
    cmake_version = subprocess.check_output(["cmake", "--version"], text=True, timeout=10).splitlines()[0]
    version = re.search(r"(\d+)\.(\d+)\.(\d+)", cmake_version)
    if not version or tuple(map(int, version.groups())) < (3, 21, 0):
        raise ValueError("CMake >=3.21 is required")
    venv.EnvBuilder(with_pip=True).create(destination)
    python = str(destination / "bin/python")
    environment = {**os.environ, "CMAKE_ARGS": CMAKE_ARGS, "CMAKE_BUILD_PARALLEL_LEVEL": "2",
                   "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_INPUT": "1"}

    def pip(*arguments):
        subprocess.run([python, "-m", "pip", *arguments], env=environment, check=True, timeout=1800)

    # Install every Python dependency as a pinned wheel, then build the hash-pinned
    # native source against those installed build tools without an unpinned build env.
    pip("install", "--only-binary=:all:", "--no-deps", *dependencies)
    pip("install", "--no-deps", "--no-build-isolation", "--no-cache-dir", native)
    pip("check")
    inspect = """
import hashlib, importlib.metadata, json, pathlib, platform, sys
from llama_cpp import llama_cpp
library = pathlib.Path(llama_cpp._lib._name).resolve(strict=True)
for symbol in ['llama_model_load_from_file', 'llama_model_get_vocab', 'llama_tokenize',
               'llama_model_meta_val_str', 'llama_model_free']:
    assert callable(getattr(llama_cpp, symbol))
assert importlib.metadata.version('llama-cpp-python') == '0.3.16'
print(json.dumps({'python_executable': sys.executable, 'python_version': platform.python_version(),
    'llama_cpp_version': '0.3.16', 'native_library_path': str(library),
    'native_library_sha256': hashlib.sha256(library.read_bytes()).hexdigest()}))
"""
    identity = json.loads(subprocess.check_output([python, "-I", "-B", "-c", inspect],
                                                 env=environment, text=True, timeout=60))
    identity.update({"cmake": cmake_version, "cmake_args": CMAKE_ARGS,
                     "source_requirement": native, "model_parity_verified": False})
    (destination / "tokenizer-build.json").write_text(json.dumps(identity, indent=2) + "\n")
    frozen = subprocess.check_output([python, "-m", "pip", "freeze", "--all"],
                                     env=environment, text=True, timeout=30)
    (destination / "requirements-resolved.txt").write_text(frozen)
    print(json.dumps(identity, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", required=True, help="New absolute virtual-environment path")
    parser.add_argument("--dry-run", action="store_true", help="Validate and show the plan without changes or network")
    arguments = parser.parse_args()
    try:
        destination, dependencies, native = build_plan(arguments.venv)
        if arguments.dry_run:
            print(json.dumps({"venv": str(destination), "dependencies": dependencies,
                              "native_source": native, "cmake_args": CMAKE_ARGS}, indent=2))
        else:
            provision(destination)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Tokenizer provisioning failed: {type(error).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
