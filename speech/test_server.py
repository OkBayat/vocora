import json
from pathlib import Path
import tempfile
import unittest
from server import RecognitionPool, SpeechError, measured_model_digest

class Recognizer:
    def __init__(self): self.calls = 0
    def AcceptWaveform(self, _audio): self.calls += 1; return self.calls == 2
    def PartialResult(self): return json.dumps({'partial': 'hello'})
    def Result(self): return json.dumps({'text': 'hello world'})
    def FinalResult(self): return json.dumps({'text': 'again'})

class PoolTests(unittest.TestCase):
    def test_model_digest_measures_paths_and_bytes_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError): measured_model_digest(root)
            (root / 'config').mkdir()
            (root / 'config/model.conf').write_text('setting=1')
            first = measured_model_digest(root)
            self.assertRegex(first, r'^sha256:[a-f0-9]{64}$')
            self.assertEqual(first, measured_model_digest(root))
            (root / 'config/model.conf').write_text('setting=2')
            self.assertNotEqual(first, measured_model_digest(root))
            second = measured_model_digest(root)
            (root / 'config/model.conf').rename(root / 'config/renamed.conf')
            self.assertNotEqual(second, measured_model_digest(root))
            (root / 'linked').symlink_to(root / 'config/renamed.conf')
            with self.assertRaises(ValueError): measured_model_digest(root)

    def test_detailed_results_preserve_real_word_evidence_and_legacy_text(self):
        class Detailed(Recognizer):
            def SetWords(self, value): self.words_enabled = value
            def SetPartialWords(self, value): self.partial_words_enabled = value
            def PartialResult(self): return json.dumps({'partial': 'hello', 'partial_result': [
                {'word': 'hello', 'start': 0.0, 'end': 0.3, 'conf': 0.7}]})
            def Result(self): return json.dumps({'text': 'hello world', 'result': [
                {'word': 'hello', 'start': 0.0, 'end': 0.3, 'conf': 0.91},
                {'word': 'world', 'start': 0.3, 'end': 0.6}]})
            def FinalResult(self): return json.dumps({'text': 'again', 'result': [
                {'word': 'again', 'start': 0.7, 'end': 1.0, 'conf': 0.8}]})
        identity = {'provider': 'vosk', 'runtimeVersion': '0.3.45', 'modelId': 'test-model', 'modelDigest': None}
        pool = RecognitionPool(Detailed, provider_identity=identity)
        pool.start('one')
        self.assertTrue(pool.sessions['one']['recognizer'].words_enabled)
        self.assertTrue(pool.sessions['one']['recognizer'].partial_words_enabled)
        partial = pool.process('one', b'\0\0', 0)
        self.assertEqual(partial['status'], 'partial')
        self.assertEqual(partial['wordEvidence'][0]['confidence'], 0.7)
        pool.process('one', b'\0\0', 1)
        result = pool.process('one', final=True)
        self.assertEqual(result['schemaVersion'], 1)
        self.assertEqual(result['status'], 'transcribed')
        self.assertEqual(result['text'], 'hello world again')
        self.assertIsNone(result['confidence'])
        self.assertEqual([word['confidence'] for word in result['wordEvidence']], [0.91, None, 0.8])
        self.assertEqual(result['providerIdentity'], identity)
        self.assertEqual(result, pool.process('one', final=True))

    def test_silence_and_missing_word_confidence_never_invent_evidence(self):
        class Silent(Recognizer):
            def FinalResult(self): return json.dumps({'text': ''})
        pool = RecognitionPool(Silent)
        pool.start('one')
        result = pool.process('one', final=True)
        self.assertEqual(result['status'], 'insufficient_evidence')
        self.assertEqual(result['wordEvidence'], [])
        self.assertIsNone(result['providerIdentity']['modelDigest'])
        self.assertIsNone(result['providerIdentity']['modelId'])

    def test_bad_provider_json_and_unbounded_evidence_fail_without_private_text(self):
        for data in ['private transcript invalid JSON', json.dumps({'text': 'x' * 8001}),
                     json.dumps({'text': 'hello\ud800'}), json.dumps({'text': 'hello\0'}),
                     json.dumps({'text': 'hello', 'result': [{'word': 'hello', 'start': 1, 'end': 0, 'conf': 0.5}]}),
                     json.dumps({'text': 'hello', 'result': [{'word': 'hello', 'start': 0, 'end': 1, 'conf': 4}]}),
                     json.dumps({'text': 'hello', 'result': [{'word': 'hello', 'start': 0, 'end': 1}] * 501})]:
            class Broken(Recognizer):
                def FinalResult(self): return data
            pool = RecognitionPool(Broken)
            pool.start('one')
            with self.assertRaises(SpeechError) as raised:
                pool.process('one', final=True)
            self.assertEqual(raised.exception.status, 502)
            self.assertNotIn('private transcript', str(raised.exception))
            self.assertIsNone(pool.sessions['one']['recognizer'])
            with self.assertRaises(SpeechError): pool.process('one', final=True)

    def test_stream_and_final_are_idempotent(self):
        pool = RecognitionPool(Recognizer)
        pool.start('one')
        self.assertEqual(pool.process('one', b'\0\0', 0)['text'], 'hello')
        self.assertEqual(pool.process('one', b'\0\0', 0)['text'], 'hello')
        self.assertEqual(pool.process('one', b'\0\0', 1)['text'], 'hello world')
        self.assertEqual(pool.process('one', final=True)['text'], 'hello world again')
        self.assertEqual(pool.process('one', final=True)['text'], 'hello world again')
        self.assertIsNone(pool.sessions['one']['recognizer'])

    def test_order_limits_expiry_and_cleanup(self):
        clock = [0]
        pool = RecognitionPool(Recognizer, capacity=1, clock=lambda: clock[0])
        pool.start('one')
        with self.assertRaises(SpeechError): pool.start('two')
        with self.assertRaises(SpeechError): pool.process('one', b'\0\0', 1)
        with self.assertRaises(SpeechError): pool.process('one', b'\0', 0)
        with self.assertRaises(SpeechError): pool.process('one', b'\0' * 32002, 0)
        clock[0] = 91
        pool.start('two')
        self.assertNotIn('one', pool.sessions)
        pool.cancel('two')
        self.assertEqual(len(pool.sessions), 0)

if __name__ == '__main__': unittest.main()
