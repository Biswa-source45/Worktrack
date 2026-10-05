# Face test fixtures

Four AI-generated faces of people who do not exist (StyleGAN output). Each is marked **Public domain**
on Wikimedia Commons (category PD-algorithm: no human authorship). They were checked on 2026-10-05
and shrunk to 512 x 512 JPEG (quality 85). No photo of a real person is in this repository.

| File | Commons page | Licence on Commons |
|---|---|---|
| person_a.jpg | https://commons.wikimedia.org/wiki/File:Boy_1.jpg | Public domain |
| person_b.jpg | https://commons.wikimedia.org/wiki/File:Man_2.jpg | Public domain |
| person_c.jpg | https://commons.wikimedia.org/wiki/File:This_Person_Does_Not_Exist_example.jpg | Public domain |
| person_d.jpg | https://commons.wikimedia.org/wiki/File:Woman_1.jpg | Public domain |

The other cases (no face, two faces, blurred, dark, bright, small, rotated, a "same person"
second photo) are generated in `tests/modules/face/images.py` from these four.

Limit: a generated "same person" photo (crop, rotation, brightness, JPEG) is much easier than a
real second photo of someone. Real-world scores come from `scripts/calibrate_faces.py` run on
local photos that never enter the repository.
