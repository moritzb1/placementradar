"""
build_category_bank.py — text fingerprints of ~90 PRODUCT TYPES for "Verify on screen" (public/js/verify.js).

Why this file exists (23 Nov): Verify on screen wants a zero-shot check for products that are not packages
(monitor, Mac mini, microphone, speaker …). A true zero-shot check of the product NAMES from each analysis would
need MobileCLIP-S1's text encoder in the browser: 63.4 M parameters = ~127 MB as float16 (~63 MB as int8), i.e.
3–6 files over Cloudflare's 25 MiB limit and more than the whole live scanner downloads today, plus a CLIP BPE
tokenizer in JavaScript. Too heavy for an optional check → not shipped.

Instead we embed a FIXED list of product types once, here on the Mac, with the same text encoder, and ship only the
result: 90 × 512 float16 = 90 KB. In the browser the existing MobileCLIP-S1 image encoder (already used by the own
brand model) embeds the crop where a product should be, and verify.js asks: is the expected TYPE ("computer
monitor") among the best-matching types? That checks the object type, not the brand – the UI says so.
Distractor types (person, face, hand, wall, empty desk, text on a screen …) are in the list on purpose, so a crop
that shows the presenter or background ranks them first.

Licence: MobileCLIP weights (Apple, github.com/apple/ml-mobileclip) – same terms as the image encoder we already use.

Run:  daten_s3/py placementradar/tools/build_category_bank.py   (writes public/models/category_text.{bin,json})
"""
import json
from pathlib import Path

import numpy as np
import open_clip
import torch

ENC, PRE = "MobileCLIP-S1", "datacompdr"  # must be the encoder of public/models/brand_encoder.*.bin
PROMPT = "a photo of a {}"
OUT = Path(__file__).resolve().parents[1] / "public" / "models"

TYPES = [
    # tech / desk
    "computer monitor", "television", "laptop", "small desktop computer", "desktop computer tower", "computer keyboard",
    "computer mouse", "trackpad", "microphone", "speaker", "smart speaker", "soundbar", "headphones", "earbuds",
    "smartphone", "tablet computer", "smartwatch", "wristwatch", "camera", "camera lens", "webcam", "tripod",
    "desk lamp", "monitor light bar", "ring light", "external hard drive", "usb hub", "phone charger", "power bank",
    "cable", "game controller", "game console", "router", "printer", "drawing tablet", "foot rest",
    # bags, fashion
    "backpack", "handbag", "tote bag", "suitcase", "wallet", "sunglasses", "glasses", "shoe", "sneaker", "t-shirt",
    "hoodie", "jacket", "cap", "belt",
    # packages, kitchen, cosmetics
    "bottle", "water bottle", "coffee mug", "drinking glass", "can", "glass jar", "cosmetics bottle", "lipstick",
    "perfume bottle", "tube of cream", "makeup palette", "snack bag", "cereal box", "chocolate bar", "cardboard box",
    "espresso machine", "coffee grinder", "kettle", "blender", "frying pan",
    # home, hobby, mobility
    "potted plant", "flower", "lego set", "toy", "book", "notebook", "pen", "office chair", "desk", "shelf", "car",
    "bicycle", "electric bike", "helmet",
    # distractors: what a crop shows when the product is NOT there
    "person", "face", "hand", "wall", "window", "empty desk", "room", "text on a screen", "dark background",
]


def main():
    m, _, _ = open_clip.create_model_and_transforms(ENC, pretrained=PRE)
    tok = open_clip.get_tokenizer(ENC)
    with torch.no_grad():
        T = torch.nn.functional.normalize(m.eval().encode_text(tok([PROMPT.format(t) for t in TYPES])), dim=-1).float().numpy()
    (OUT / "category_text.bin").write_bytes(T.astype(np.float16).tobytes())
    meta = {"encoder": f"{ENC} ({PRE})", "prompt": PROMPT, "dim": int(T.shape[1]), "names": TYPES,
            "distractors": TYPES[TYPES.index("person"):], "file": "category_text.bin", "dtype": "float16"}
    (OUT / "category_text.json").write_text(json.dumps(meta, indent=1))
    print(f"{len(TYPES)} types × {T.shape[1]} → {(OUT / 'category_text.bin').stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
