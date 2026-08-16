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


class IdentityForKey(unittest.TestCase):
    """Which cwd/launcher/mcp/tools a session key resolves to.

    THE ROUTING FIX: `ClaudeProcess` used to read the module-level CWD
    constant no matter which key spawned it, so every identity's spoken turns
    landed in this instance's one default persona regardless of which guild
    was actually talking — s2s wires its backend once at process startup, so
    the shim itself has to make persona a function of the key.
    """

    def setUp(self):
        self._previous = shim.IDENTITIES
        shim.IDENTITIES = {
            "111": {"cwd": "/tmp/guild-a", "claude_script": "/tmp/cc-a"},
            "222": {"cwd": "/tmp/guild-b"},   # only cwd overridden
        }

    def tearDown(self):
        shim.IDENTITIES = self._previous

    def test_an_unconfigured_guild_falls_back_to_the_instance_default(self):
        resolved = shim.identity_for("voice:999")
        self.assertEqual(resolved["cwd"], shim.CWD)
        self.assertEqual(resolved["claude_script"], shim.CLAUDE_SCRIPT)

    def test_a_configured_guild_gets_its_own_cwd_and_launcher(self):
        resolved = shim.identity_for("voice:111")
        self.assertEqual(resolved["cwd"], "/tmp/guild-a")
        self.assertEqual(resolved["claude_script"], "/tmp/cc-a")

    def test_fields_left_unset_for_a_guild_still_fall_back_to_the_default(self):
        # Guild 222 overrides only cwd — claude_script/mcp_config/allowed_tools
        # must come from the instance default, not go missing or empty.
        resolved = shim.identity_for("voice:222")
        self.assertEqual(resolved["cwd"], "/tmp/guild-b")
        self.assertEqual(resolved["claude_script"], shim.CLAUDE_SCRIPT)
        self.assertEqual(resolved["mcp_config"], shim.MCP_CONFIG)
        self.assertEqual(resolved["allowed_tools"], shim.ALLOWED_TOOLS)

    def test_text_surfaces_never_consult_the_guild_map(self):
        # thread:/dm:/channel: keys name a channel or user, never a guild —
        # identity_for must not misread a channel/user id as a guild id that
        # happens to collide with a configured one.
        for key in ("thread:111", "dm:111", "channel:111"):
            with self.subTest(key=key):
                self.assertEqual(shim.identity_for(key)["cwd"], shim.CWD)

    def test_legacy_default_key_resolves_to_the_instance_default(self):
        self.assertEqual(shim.identity_for(shim.DEFAULT_KEY)["cwd"], shim.CWD)


class LoadIdentitiesFromConfig(unittest.TestCase):
    """Parsing the `identities:` block out of config.yaml's shape.

    A typo here must degrade to "no per-identity routing", never take the
    shim down — the same rule the rest of `_load_config()` already follows.
    """

    def setUp(self):
        self._previous_cfg = shim._CFG

    def tearDown(self):
        shim._CFG = self._previous_cfg

    def test_a_non_mapping_identities_block_is_ignored_not_fatal(self):
        shim._CFG = {"identities": "not a mapping"}
        self.assertEqual(shim._load_identities(), {})

    def test_a_non_mapping_guild_entry_is_skipped_not_fatal(self):
        shim._CFG = {"identities": {"111": "not a mapping", "222": {"cwd": "/tmp/x"}}}
        out = shim._load_identities()
        self.assertNotIn("111", out)
        self.assertEqual(out["222"]["cwd"], "/tmp/x")

    def test_only_recognised_fields_are_carried_over(self):
        shim._CFG = {"identities": {"111": {"cwd": "/tmp/x", "bogus": "ignored"}}}
        out = shim._load_identities()
        self.assertEqual(set(out["111"]), {"cwd"})

    def test_a_missing_identities_block_yields_no_overrides(self):
        shim._CFG = {}
        self.assertEqual(shim._load_identities(), {})


class TranscriptDirPerKey(unittest.TestCase):
    """Which cwd's project transcripts a key resolves to.

    A second identity's resumable-session listing must come from ITS cwd
    slug, not this instance's default one — otherwise `/v1/sessions/available`
    offers guild B someone else's conversations to resume into.
    """

    def setUp(self):
        self._previous = shim.IDENTITIES
        shim.IDENTITIES = {"111": {"cwd": "/tmp/guild-a"}}

    def tearDown(self):
        shim.IDENTITIES = self._previous

    def test_empty_key_keeps_the_instance_default_cwd(self):
        self.assertEqual(shim.transcript_dir(""), shim.transcript_dir())

    def test_a_configured_guild_key_resolves_under_its_own_cwd(self):
        expected_slug = str(shim.Path("/tmp/guild-a").resolve()).replace("/", "-")
        self.assertTrue(str(shim.transcript_dir("voice:111")).endswith(expected_slug))

    def test_an_unconfigured_voice_key_matches_the_default(self):
        self.assertEqual(shim.transcript_dir("voice:999"), shim.transcript_dir(""))


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


class LooksFactual(unittest.TestCase):
    """The backstop that forces a consult regardless of what the front tier chose.

    This is the layer that fails toward SLOW. Where it does not match, the only
    thing standing between the user and an invented fact is the front model
    deciding to refuse — and it has now been observed not to, twice, on two
    different models and two different vocabularies.
    """

    def test_the_2026_08_14_infrastructure_fabrication(self):
        # Verbatim from the live transcript. Matched nothing: no interrogative
        # in the first alternation, no `my`/`our`, and neither "benchmark" nor
        # "router" was a known noun. The front tier answered it itself with
        # "No — not yet because the necessary router components are missing",
        # an invention about the user's own setup, spoken aloud.
        self.assertTrue(shim.looks_factual(
            "Can you now give me a complete answer? Can we run the benchmark "
            "against the router?"))

    def test_the_2026_08_04_plural_fabrication(self):
        # The original incident: \btask\b cannot match "tasks", so this reached
        # the front tier and came back with an invented task name, count and
        # due date. Pinned here so the plurals cannot regress.
        self.assertTrue(shim.looks_factual("can you list all active tasks?"))

    def test_infrastructure_nouns_force_a_consult(self):
        # A growing share of spoken questions are about the setup rather than
        # the work. Each of these must reach Claude even if phrased with no
        # interrogative and no possessive.
        for text in (
            "is the router still on the old config",
            "run the benchmark again",
            "which model are we using",
            "the shim seems slow",
            "check the endpoint",
            "how much does the subscription cost",
            "what version shipped",
        ):
            with self.subTest(text=text):
                self.assertTrue(shim.looks_factual(text))

    def test_small_talk_is_not_dragged_into_a_consult(self):
        # looks_factual returns early for anything the chitchat whitelist
        # matched, so widening the noun list must not cost a greeting its
        # sub-second answer. This is the property that makes broadening safe.
        for text in ("hello", "thanks a lot", "good evening", "how are you",
                     "can you hear me", "bye"):
            with self.subTest(text=text):
                self.assertFalse(shim.looks_factual(text))
