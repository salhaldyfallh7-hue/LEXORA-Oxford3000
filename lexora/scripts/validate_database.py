#!/usr/bin/env python3
"""Validate a user-provided LEXORA JSON vocabulary dataset without modifying it."""
import argparse
import collections
import json
import sys
from pathlib import Path

LEVELS = {"A1", "A2", "B1", "B2"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a LEXORA word dataset.")
    parser.add_argument("--file", type=Path, default=Path("data/oxford3000.json"))
    args = parser.parse_args()
    path = args.file.expanduser().resolve()
    if not path.is_file():
        print(f"File not found: {path}", file=sys.stderr)
        return 2
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"Invalid JSON: {exc}", file=sys.stderr)
        return 2

    problems = []
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    words = data.get("words") if isinstance(data, dict) else None
    if not isinstance(words, list):
        problems.append("words must be an array")
        words = []
    elif not words:
        problems.append("words must contain at least one authorized vocabulary record before the app can run")

    ids = set()
    counts = collections.Counter()
    distinct_headwords = set()
    for index, word in enumerate(words):
        prefix = f"words[{index}]"
        if not isinstance(word, dict):
            problems.append(f"{prefix} must be an object")
            continue
        word_id = word.get("id")
        headword = word.get("headword")
        if not isinstance(word_id, str) or not word_id.strip():
            problems.append(f"{prefix}.id must be a non-empty string")
        elif word_id in ids:
            problems.append(f"duplicate id: {word_id}")
        else:
            ids.add(word_id)
        if not isinstance(headword, str) or not headword.strip():
            problems.append(f"{prefix}.headword must be a non-empty string")
            continue
        distinct_headwords.add(headword.casefold())
        forms = word.get("forms")
        levels = word.get("levels")
        meanings = word.get("meanings")
        if not isinstance(forms, list) or not forms:
            problems.append(f"{prefix}.forms must be a non-empty array")
            forms = []
        form_levels = set()
        for form_index, form in enumerate(forms):
            if not isinstance(form, dict) or not isinstance(form.get("partOfSpeech"), str) or not form.get("partOfSpeech", "").strip():
                problems.append(f"{prefix}.forms[{form_index}] must include non-empty partOfSpeech text")
                continue
            level = form.get("level")
            if level is not None and (not isinstance(level, str) or level not in LEVELS):
                problems.append(f"{prefix}.forms[{form_index}].level must be A1/A2/B1/B2 or null")
            elif level:
                form_levels.add(level)
        expected_levels = sorted(form_levels, key=["A1", "A2", "B1", "B2"].index)
        valid_levels_list = (
            isinstance(levels, list)
            and all(isinstance(level, str) and level in LEVELS for level in levels)
            and len(levels) == len(set(levels))
        )
        if not valid_levels_list or levels != expected_levels:
            problems.append(f"{prefix}.levels must match the distinct non-null levels in forms in A1-to-B2 order")
        else:
            for level in expected_levels:
                counts[level] += 1
        if not isinstance(meanings, list) or not all(isinstance(item, str) for item in meanings):
            problems.append(f"{prefix}.meanings must be an array of strings")

    if problems:
        print(f"INVALID: {len(problems)} issue(s) found.")
        for problem in problems[:40]:
            print(f"- {problem}")
        if len(problems) > 40:
            print(f"... and {len(problems)-40} more")
        return 1

    print("VALID LEXORA dataset.")
    print(f"Records: {len(words)} | Case-insensitive headwords: {len(distinct_headwords)}")
    for level in ("A1", "A2", "B1", "B2"):
        print(f"{level}: {counts[level]} record(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
