"""scripts/download_models.py: verified downloads, no half-written files, no bad copies."""

import hashlib
from pathlib import Path

import pytest

from scripts import download_models as dm

GOOD = b"model bytes"
ASSET = dm.Asset("m.onnx", "dir/m.onnx", hashlib.sha256(GOOD).hexdigest())


class Net:
    def __init__(self, *answers: bytes | OSError) -> None:
        self.answers = list(answers)
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        answer = self.answers.pop(0)
        if isinstance(answer, OSError):
            raise answer
        return answer


def test_downloads_a_missing_file_from_the_pinned_commit(tmp_path: Path) -> None:
    net = Net(GOOD)
    assert dm.ensure(ASSET, tmp_path, net) == "downloaded"
    assert (tmp_path / "m.onnx").read_bytes() == GOOD
    assert dm.COMMIT in net.urls[0]
    assert not list(tmp_path.glob("*.part"))


def test_leaves_a_matching_file_alone(tmp_path: Path) -> None:
    (tmp_path / "m.onnx").write_bytes(GOOD)
    net = Net()
    assert dm.ensure(ASSET, tmp_path, net) == "ok"
    assert net.urls == []


def test_replaces_a_damaged_file(tmp_path: Path) -> None:
    (tmp_path / "m.onnx").write_bytes(b"damaged")
    assert dm.ensure(ASSET, tmp_path, Net(GOOD)) == "downloaded"
    assert (tmp_path / "m.onnx").read_bytes() == GOOD


def test_falls_back_to_the_second_source_when_the_first_fails(tmp_path: Path) -> None:
    net = Net(OSError("offline"), GOOD)
    assert dm.ensure(ASSET, tmp_path, net) == "downloaded"
    assert "huggingface.co" in net.urls[1]


def test_a_wrong_checksum_is_never_written(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        dm.ensure(ASSET, tmp_path, Net(b"tampered", b"tampered"))
    assert list(tmp_path.iterdir()) == []


def test_refuses_plain_http() -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        dm.fetch("http://example.com/x")


def test_every_asset_has_a_full_sha256() -> None:
    for asset in dm.ASSETS:
        assert len(asset.sha256) == 64
        int(asset.sha256, 16)
