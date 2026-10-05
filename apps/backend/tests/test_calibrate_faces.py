"""scripts/calibrate_faces.py: reads a folder of labelled photos, prints scores, writes nothing."""

import hashlib
from pathlib import Path

import pytest

from scripts import calibrate_faces as cal
from tests.modules.face import images


def build(root: Path) -> None:
    for person, name in (("ann", "a"), ("raj", "b"), ("kim", "c")):
        folder = root / person
        folder.mkdir()
        (folder / "one.jpg").write_bytes(images.photo(name))
        (folder / "two.jpg").write_bytes(images.same_person(name, 1))
        (folder / "three.jpg").write_bytes(images.same_person(name, 2))
    (root / "ann" / "wall.jpg").write_bytes(images.empty_wall())
    (root / "raj" / "dark.jpg").write_bytes(images.darkened("b", 0.3))
    (root / "raj" / "notes.txt").write_text("not a photo")


def fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_scores_pairs_and_reports_photos_that_cannot_be_used(tmp_path: Path) -> None:
    build(tmp_path)
    report = cal.calibrate(tmp_path)
    # ann 3 usable photos, raj 4 (the dark one still has a face), kim 3.
    assert len(report.genuine) == 3 + 6 + 3
    assert len(report.impostor) == 3 * 4 + 3 * 3 + 4 * 3
    assert min(report.genuine) > 0.9
    assert max(report.impostor) < 0.3
    assert [p.unusable for p in report.people["ann"]].count(cal.Issue.NO_FACE) == 1
    # A photo can be too dark for the gates and still count for the scores.
    raj = report.people["raj"]
    assert [p.fails for p in raj].count(cal.Issue.TOO_DARK) == 1
    assert all(p.embedding is not None for p in raj)


def test_the_report_has_the_distributions_and_the_error_table(tmp_path: Path) -> None:
    build(tmp_path)
    text = cal.render(cal.calibrate(tmp_path))
    for heading in ("PHOTOS", "QUALITY OF THE USABLE PHOTOS", "SCORES", "ERROR RATE"):
        assert heading in text
    assert "#4: unusable (NO_FACE)" in text
    assert "#1: would be a retake today (TOO_DARK)" in text
    rows = {line.split()[0]: line for line in text.splitlines() if line.count("%") == 2}
    assert set(rows) == {f"{t:.3f}" for t in cal.SCAN}
    assert "<- current verify threshold" in rows["0.400"]
    assert "<- current review threshold" in rows["0.300"]
    # Synthetic people are far apart: at the current thresholds nobody is wrongly accepted or
    # rejected, while at 0.200 a third of the impostor pairs would pass.
    assert rows["0.400"].replace("%", " ").split()[1:3] == ["0.0", "0.0"]
    assert float(rows["0.200"].replace("%", " ").split()[1]) > 30
    assert "Lowest scanned threshold with no impostor accepted: 0.275." in text
    assert "Only 33 impostor pairs (<100)" in text  # a small sample is called out


def test_it_prints_numbers_only_never_names_or_images(tmp_path: Path) -> None:
    build(tmp_path)
    text = cal.render(cal.calibrate(tmp_path))
    for leaked in ("one.jpg", "two.jpg", "wall.jpg", "notes.txt", str(tmp_path)):
        assert leaked not in text


def test_it_writes_nothing(tmp_path: Path) -> None:
    build(tmp_path)
    before = fingerprint(tmp_path)
    cal.render(cal.calibrate(tmp_path))
    assert fingerprint(tmp_path) == before


def test_the_command_line_reports_bad_input(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cal.main([str(tmp_path / "missing")]) == 2
    assert "not a folder" in capsys.readouterr().err
    (tmp_path / "only-one").mkdir()
    (tmp_path / "only-one" / "a.jpg").write_bytes(images.photo("a"))
    assert cal.main([str(tmp_path)]) == 2
    assert "at least 2" in capsys.readouterr().err
    (tmp_path / "x").mkdir()
    build(tmp_path / "x")
    assert cal.main([str(tmp_path / "x")]) == 0
    assert "ERROR RATE" in capsys.readouterr().out
