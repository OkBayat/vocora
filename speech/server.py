"""Private streaming speech service. Audio is processed in memory, never retained."""
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAX_CHUNK = 32000
MAX_AUDIO = 16000 * 2 * 30
MAX_TEXT = 8000
MAX_WORDS = 500
MAX_RESULT_BYTES = 128 * 1024


class SpeechError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def safe_text(value, maximum):
    return (isinstance(value, str) and len(value) <= maximum
            and not any(unicodedata.category(char) in ('Cc', 'Cs')
                        or '\u202a' <= char <= '\u202e' or '\u2066' <= char <= '\u2069'
                        for char in value))


def provider_result(encoded, partial=False):
    if not isinstance(encoded, str) or len(encoded.encode('utf-8')) > MAX_RESULT_BYTES:
        raise ValueError('Invalid recognition result')
    data = json.loads(encoded)
    text = data.get('partial' if partial else 'text', '')
    if not safe_text(text, MAX_TEXT):
        raise ValueError('Invalid transcript')
    words = data.get('partial_result' if partial else 'result', [])
    if not isinstance(words, list) or len(words) > MAX_WORDS:
        raise ValueError('Invalid word evidence')
    evidence = []
    previous_start = 0
    for item in words:
        word, start, end, confidence = (item.get(key) for key in ['word', 'start', 'end', 'conf'])
        if (not safe_text(word, 128) or not word.strip()
                or any(isinstance(value, bool) or not isinstance(value, (float, int))
                       or not math.isfinite(value) for value in [start, end])
                or not previous_start <= start <= end <= 30
                or (confidence is not None and (isinstance(confidence, bool)
                    or not isinstance(confidence, (float, int)) or not math.isfinite(confidence)
                    or not 0 <= confidence <= 1))):
            raise ValueError('Invalid word evidence')
        previous_start = start
        evidence.append({'word': word, 'startSeconds': start, 'endSeconds': end, 'confidence': confidence})
    return text, evidence


def measured_model_digest(directory):
    """SHA256 of sorted [relative POSIX path, file SHA256] JSON pairs, UTF-8/compact.

    This measures model files, never microphone recordings. Reject symlinks so
    provenance cannot include arbitrary files outside the configured model tree.
    """
    root = Path(directory)
    entries = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Model directory must not contain symlinks')
        if path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            entries.append([path.relative_to(root).as_posix(), digest.hexdigest()])
    if not entries:
        raise ValueError('Model directory is empty')
    canonical = json.dumps(entries, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    return 'sha256:' + hashlib.sha256(canonical).hexdigest()


class RecognitionPool:
    def __init__(self, factory, capacity=8, clock=time.monotonic, provider_identity=None):
        self.factory, self.capacity, self.clock = factory, capacity, clock
        self.sessions = {}
        self.lock = threading.RLock()
        self.provider_identity = provider_identity or {
            'provider': 'vosk', 'runtimeVersion': None, 'modelId': None, 'modelDigest': None,
        }

    def result(self, text, words, final=False):
        if len(text) > MAX_TEXT or len(words) > MAX_WORDS:
            raise ValueError('Recognition result exceeds limits')
        result = {'schemaVersion': 1, 'status': ('transcribed' if text.strip() else 'insufficient_evidence')
                  if final else 'partial', 'text': text, 'confidence': None,
                  'wordEvidence': words, 'providerIdentity': dict(self.provider_identity)}
        if len(json.dumps(result).encode('utf-8')) > MAX_RESULT_BYTES:
            raise ValueError('Recognition result exceeds limits')
        return result

    def sweep(self):
        now = self.clock()
        for key, state in list(self.sessions.items()):
            if now - state['touched'] > 90:
                del self.sessions[key]

    def start(self, key):
        with self.lock:
            self.sweep()
            if key not in self.sessions:
                if len(self.sessions) >= self.capacity:
                    raise SpeechError(429, 'All speech slots are occupied.')
                try:
                    recognizer = self.factory()
                    for method in ['SetWords', 'SetPartialWords']:
                        if callable(getattr(recognizer, method, None)):
                            getattr(recognizer, method)(True)
                    self.sessions[key] = {
                        'recognizer': recognizer, 'touched': self.clock(),
                        'bytes': 0, 'sequence': 0, 'committed': [], 'words': [],
                        'final': None, 'cached': None, 'failed': False,
                    }
                except Exception:
                    raise SpeechError(502, 'Speech processing failed.') from None
            return {'status': 'ready'}

    def cancel(self, key):
        with self.lock:
            self.sessions.pop(key, None)
        return {'status': 'closed'}

    def process(self, key, audio=None, sequence=None, final=False):
        # Bound CPU parallelism as well as the number of recognizers.
        with self.lock:
            self.sweep()
            state = self.sessions.get(key)
            if state is None:
                raise SpeechError(404, 'Recording expired.')
            state['touched'] = self.clock()
            recognizer = state['recognizer']
            if state['failed']:
                raise SpeechError(502, 'Speech processing failed. Start a new recording.')
            if final:
                if state['final'] is None:
                    try:
                        text, words = provider_result(recognizer.FinalResult())
                        state['final'] = self.result(' '.join(filter(None, [*state['committed'], text])),
                                                     [*state['words'], *words], final=True)
                        state['recognizer'] = None
                    except Exception:
                        state['failed'], state['recognizer'] = True, None
                        raise SpeechError(502, 'Speech processing failed. Start a new recording.') from None
                return state['final']
            if audio is None or not 0 < len(audio) <= MAX_CHUNK or len(audio) % 2:
                raise SpeechError(400, 'Expected PCM16 mono audio.')
            digest = hashlib.sha256(audio).hexdigest()
            cached = state['cached']
            if cached and cached[:2] == (sequence, digest):
                return cached[2]
            if state['final'] is not None or sequence != state['sequence']:
                raise SpeechError(409, 'Audio is out of order.')
            if state['bytes'] + len(audio) > MAX_AUDIO:
                raise SpeechError(413, 'Recording exceeds 30 seconds.')
            try:
                if recognizer.AcceptWaveform(audio):
                    text, words = provider_result(recognizer.Result())
                    committed = [*state['committed'], text] if text else state['committed']
                    words = [*state['words'], *words]
                    result = self.result(' '.join(committed), words)
                    state['committed'], state['words'] = committed, words
                else:
                    partial, words = provider_result(recognizer.PartialResult(), partial=True)
                    result = self.result(' '.join(filter(None, [*state['committed'], partial])),
                                         [*state['words'], *words])
            except Exception:
                # The recognizer may already have consumed this chunk. Do not replay it.
                state['failed'], state['recognizer'] = True, None
                raise SpeechError(502, 'Speech processing failed. Start a new recording.') from None
            state['bytes'] += len(audio)
            state['sequence'] += 1
            state['cached'] = (sequence, digest, result)
            return result


def make_handler(pool):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass

        def reply(self, status, data):
            payload = json.dumps(data).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)

        def dispatch(self):
            try:
                parsed = urlparse(self.path)
                if self.command == 'GET' and parsed.path == '/health':
                    return self.reply(200, {'status': 'ok'})
                match = re.fullmatch(r'/sessions/([0-9a-f-]{36})(?:/(chunks|finish))?', parsed.path)
                if not match:
                    raise SpeechError(404, 'Not found.')
                key, action = match.groups()
                if self.command == 'PUT' and action is None:
                    result = pool.start(key)
                elif self.command == 'DELETE' and action is None:
                    result = pool.cancel(key)
                elif self.command == 'POST' and action == 'finish':
                    result = pool.process(key, final=True)
                elif self.command == 'POST' and action == 'chunks':
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= MAX_CHUNK:
                        raise SpeechError(413, 'Invalid audio size.')
                    sequence = int(parse_qs(parsed.query).get('sequence', ['-1'])[0])
                    audio = self.rfile.read(length)
                    if len(audio) != length:
                        raise SpeechError(400, 'Incomplete audio.')
                    result = pool.process(key, audio, sequence)
                else:
                    raise SpeechError(405, 'Method not allowed.')
                self.reply(200, result)
            except SpeechError as exc:
                self.reply(exc.status, {'error': str(exc)})
            except (ValueError, TimeoutError):
                self.reply(400, {'error': 'Invalid request.'})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.reply(500, {'error': 'Speech processing failed.'})

        do_GET = dispatch
        do_PUT = dispatch
        do_POST = dispatch
        do_DELETE = dispatch
    return Handler


if __name__ == '__main__':
    from vosk import KaldiRecognizer, Model, SetLogLevel
    SetLogLevel(-1)
    model_path = os.environ.get('VOSK_MODEL_PATH', '/opt/model')
    model_digest = measured_model_digest(model_path)
    if os.environ.get('VOSK_MODEL_DIGEST') and os.environ['VOSK_MODEL_DIGEST'] != model_digest:
        raise RuntimeError('Speech model digest does not match the configured pin.')
    model_id = os.environ.get('VOSK_MODEL_ID') or None
    if model_id is not None and (not safe_text(model_id, 128) or not model_id.strip()):
        raise RuntimeError('Invalid speech model identity.')
    model = Model(model_path)
    pool = RecognitionPool(lambda: KaldiRecognizer(model, 16000), provider_identity={
        'provider': 'vosk', 'runtimeVersion': importlib.metadata.version('vosk'),
        'modelId': model_id, 'modelDigest': model_digest,
    })
    server = ThreadingHTTPServer(('0.0.0.0', 8080), make_handler(pool))
    server.daemon_threads = True
    server.serve_forever()
