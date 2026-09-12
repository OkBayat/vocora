#!/usr/bin/env python3
"""Count a bounded raw Qwen prompt using the provisioned Ollama GGUF vocabulary.

No model acquisition, inference, network access, or learner-text logging occurs.
Provision llama-cpp-python separately with an exact package and native-library pin.
Ollama prompt_eval_count parity remains an independent acceptance check.
"""

import ctypes
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import sys

MAX_REQUEST_BYTES = 2 * 1024 * 1024
SHA256 = re.compile(r"[a-f0-9]{64}\Z")


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition):
    if not condition:
        raise ValueError("Tokenizer identity or request is invalid")


def file_identity(path):
    state = path.stat()
    return (state.st_dev, state.st_ino, state.st_size, state.st_mtime_ns, state.st_ctime_ns)


def verified_model(request):
    manifest_path = Path(request["manifest_path"])
    model_path = Path(request["model_path"])
    require(manifest_path.is_absolute() and model_path.is_absolute())
    require(manifest_path.stat().st_size <= MAX_REQUEST_BYTES)
    manifest_bytes = manifest_path.read_bytes()
    require("sha256:" + hashlib.sha256(manifest_bytes).hexdigest() == request["model_digest"])
    manifest = json.loads(manifest_bytes)
    layers = manifest.get("layers", [])
    models = [item for item in layers if item.get("mediaType") == "application/vnd.ollama.image.model"]
    templates = [item for item in layers if item.get("mediaType") == "application/vnd.ollama.image.template"]
    require(len(models) == 1 and len(templates) == 1)
    template_digest = templates[0].get("digest")
    require(isinstance(template_digest, str) and template_digest.startswith("sha256:")
            and SHA256.fullmatch(template_digest[7:]))
    model_digest = models[0]["digest"]
    require(model_digest.startswith("sha256:") and SHA256.fullmatch(model_digest[7:]))
    before = file_identity(model_path)
    require(before[2] == models[0]["size"])
    with model_path.open("rb") as stream:
        require(stream.read(4) == b"GGUF")
    require("sha256:" + file_sha256(model_path) == model_digest)
    require(file_identity(model_path) == before)
    return model_path, model_digest, before


def count(request):
    require(isinstance(request, dict))
    require(isinstance(request.get("prompt"), str))
    require(0 < len(request["prompt"].encode("utf-8")) <= 131072)
    require(SHA256.fullmatch(request.get("template_sha256", "")))
    require(SHA256.fullmatch(request.get("native_library_sha256", "")))
    model_path, model_digest, model_stat = verified_model(request)
    version = importlib.metadata.version("llama-cpp-python")
    require(version == request["llama_cpp_version"])
    # Loading the native library is local. Pin the actual loaded binary, not its filename.
    from llama_cpp import llama_cpp

    library_path = Path(llama_cpp._lib._name).resolve(strict=True)
    require(file_sha256(library_path) == request["native_library_sha256"])
    llama_cpp.llama_backend_init()
    parameters = llama_cpp.llama_model_default_params()
    parameters.vocab_only = True
    parameters.n_gpu_layers = 0
    model = llama_cpp.llama_model_load_from_file(str(model_path).encode("utf-8"), parameters)
    require(model)
    try:
        for key, expected in [(b"general.architecture", b"qwen3"),
                              (b"tokenizer.ggml.pre", b"qwen2")]:
            buffer = ctypes.create_string_buffer(128)
            length = llama_cpp.llama_model_meta_val_str(model, key, buffer, len(buffer))
            require(0 < length < len(buffer) and buffer.value == expected)
        vocabulary = llama_cpp.llama_model_get_vocab(model)
        require(vocabulary)
        encoded_prompt = request["prompt"].encode("utf-8")
        # add_special honors the GGUF BOS policy; parse_special recognizes ChatML.
        # No inference context, KV cache or tensor weights are allocated.
        required = -llama_cpp.llama_tokenize(vocabulary, encoded_prompt, len(encoded_prompt),
                                            None, 0, True, True)
        require(0 < required <= 131082)
        tokens = (llama_cpp.llama_token * required)()
        token_count = llama_cpp.llama_tokenize(vocabulary, encoded_prompt, len(encoded_prompt),
                                              tokens, required, True, True)
        require(token_count == required)
        require(file_identity(model_path) == model_stat)
    finally:
        llama_cpp.llama_model_free(model)
    identity = (f"llama-cpp-python:{version};native-sha256:{request['native_library_sha256']};"
                f"gguf-{model_digest};add_bos=true;special=true")
    return {"input_tokens": token_count, "model_digest": request["model_digest"],
            "template_sha256": request["template_sha256"], "tokenizer_identity": identity,
            "llama_cpp_version": version, "native_library_sha256": request["native_library_sha256"]}


def main():
    try:
        encoded = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        require(len(encoded) <= MAX_REQUEST_BYTES)
        result = count(json.loads(encoded))
    except Exception:
        # Native stderr is suppressed by the Node adapter; never serialize exceptions/drafts.
        print(json.dumps({"error": "TOKENIZER_UNAVAILABLE"}))
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
