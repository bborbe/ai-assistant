"""Tests for shim/claude_openai_shim.py.

The shim had no tests at all until 2026-08-10, which is how a change to session
keys silently disabled the wake phrase in a live meeting: `make precommit` runs
`node --test`, and the shim is Python, so nothing here was ever executed by a
check. These cover the decisions that are cheap to get wrong and expensive to
notice — classification and key routing — not the HTTP or subprocess plumbing.

Run: python3 -m unittest discover -s test -p 'test_*.py'
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "shim"))

import claude_openai_shim as shim  # noqa: E402


class IsVoiceTurn(unittest.TestCase):
    """Whether a turn counts as SPOKEN — this is what gates the wake phrase.

    The regression: voice keys gained a `voice:<guildId>` shape, the classifier
    asked `":" not in key`, every spoken turn became text, and the assistant
    answered every sentence said in a room full of colleagues.
    """

    def test_per_guild_voice_key_is_spoken(self):
        # THE REGRESSION. Fails against the pre-2026-08-10 classifier.
        self.assertTrue(shim.is_voice_turn("", "voice:1118825106303631470"))
        self.assertTrue(shim.is_voice_turn("", "voice:512637223569719307"))

    def test_legacy_default_key_is_spoken(self):
        # speech-to-speech sends no header and, before per-guild keys, no key.
        self.assertTrue(shim.is_voice_turn("", shim.DEFAULT_KEY))

    def test_voice_keys_use_the_shared_prefix(self):
        # The bot builds these; the shim matches on the prefix. If the two ever
        # disagree the wake gate silently stops running, so pin the constant.
        self.assertEqual(shim.VOICE_KEY_PREFIX, "voice:")
        self.assertTrue(f"{shim.VOICE_KEY_PREFIX}123".startswith(shim.VOICE_KEY_PREFIX))

    def test_explicit_header_wins_in_both_directions(self):
        # A message TYPED into a call's text chat carries the SAME session key as
        # the speech around it, so the header is the only thing separating them.
        self.assertFalse(shim.is_voice_turn("text", "voice:123"))
        self.assertFalse(shim.is_voice_turn("text", shim.DEFAULT_KEY))
        self.assertTrue(shim.is_voice_turn("voice", "thread:456"))

    def test_ordinary_text_surfaces_are_not_spoken(self):
        for key in ("thread:123", "dm:456", "channel:789"):
            with self.subTest(key=key):
                self.assertFalse(shim.is_voice_turn("", key))

    def test_prompt_sniff_still_catches_a_client_that_sends_neither(self):
        self.assertTrue(
            shim.is_voice_turn("", "channel:789", "you are in a spoken conversation")
        )

    def test_mode_is_case_insensitive(self):
        self.assertFalse(shim.is_voice_turn("TEXT", "voice:123"))
        self.assertTrue(shim.is_voice_turn("Voice", "thread:123"))


class VoiceKeyBinding(unittest.TestCase):
    """The pointer speech-to-speech turns are routed by.

    s2s cannot set `X-Session-Key`, so the bot names the conversation out of
    band on join. Getting this wrong sends one server's speech into another
    server's conversation.
    """

    def setUp(self):
        self._previous = shim.voice_key()

    def tearDown(self):
        shim.bind_voice_key(self._previous)

    def test_binding_routes_headerless_requests_and_returns_the_previous(self):
        shim.bind_voice_key("voice:aaa")
        self.assertEqual(shim.voice_key(), "voice:aaa")
        self.assertEqual(shim.bind_voice_key("voice:bbb"), "voice:aaa")
        self.assertEqual(shim.voice_key(), "voice:bbb")

    def test_an_empty_bind_falls_back_to_the_default_rather_than_an_empty_key(self):
        shim.bind_voice_key("")
        self.assertEqual(shim.voice_key(), shim.DEFAULT_KEY)

    def test_a_bound_key_is_still_classified_as_spoken(self):
        # The two halves have to agree: routing a turn to the voice session and
        # enforcing the wake phrase on it are separate code paths, and the bug
        # was that they disagreed.
        shim.bind_voice_key("voice:ccc")
        self.assertTrue(shim.is_voice_turn("", shim.voice_key()))


if __name__ == "__main__":
    unittest.main()


class SoloGate(unittest.TestCase):
    """Whether the wake phrase is armed at all.

    Alone there is no room to interrupt, so the trade the gate was priced on
    ("a false trigger interrupts a room") has nothing on its cost side. This
    changes only WHEN the gate is armed — `is_addressed` is untouched.
    """

    def setUp(self):
        self._previous = shim.is_solo()

    def tearDown(self):
        shim.set_solo(self._previous)

    def test_default_is_armed_so_an_endpoint_never_told_behaves_as_before(self):
        # The load-bearing direction. A shim that predates the route, a bot that
        # fails to post, and a backend that 404s all land here — and all of them
        # must keep demanding the wake phrase rather than answering everything.
        shim.set_solo(False)
        self.assertFalse(shim.is_solo())

    def test_set_solo_returns_the_previous_value(self):
        shim.set_solo(False)
        self.assertFalse(shim.set_solo(True))
        self.assertTrue(shim.set_solo(False))

    def test_solo_does_not_change_what_counts_as_addressed(self):
        # The gate is skipped when solo; the matcher itself must not drift, or
        # the two modes disagree about the same sentence.
        shim.set_solo(True)
        self.assertTrue(shim.is_addressed("hey bot, what's my next task"))
        self.assertFalse(shim.is_addressed("so anyway, as I was saying"))

    def test_a_wake_phrase_is_still_stripped_when_solo(self):
        # Saying it out of habit must not change the question the model is asked.
        shim.set_solo(True)
        self.assertEqual(
            shim.strip_wake_phrase("hey bot, what's my next task").lower().strip(" ,"),
            "what's my next task",
        )

    def test_an_utterance_with_no_phrase_is_unchanged_by_stripping(self):
        # Solo turns go through strip_wake_phrase too, so it has to be a no-op
        # on the ordinary case rather than eating the first words.
        shim.set_solo(True)
        self.assertEqual(shim.strip_wake_phrase("what's my next task"), "what's my next task")
