"""export_yoloe.py – packaging detector for the live scanner (open-vocabulary YOLOE → plain ONNX).

What:  YOLOE is a YOLO model that can be told in words which objects to find. We fix the vocabulary to
       packaging words ("snack bag", "jar", "box" …) BEFORE export, so the text encoder is baked into the
       weights and the browser only runs a normal detector (no CLIP text model on the device).
Why:   YOLO26 is trained on COCO (80 classes) and does not know bags, jars, tubs or boxes – on the 19.11.
       test photo it found nothing. YOLOE with packaging words should.
Out:   public/models/yoloe_pack.onnx + yoloe_pack.json (class names, input size)
       Two size steps after export: (1) the segmentation-mask branch is cut off (we only use boxes),
       (2) weights are stored as float16 (inputs/outputs stay float32) → 40 MB → 19 MB, which also keeps the
       file below Cloudflare's 25 MiB limit per static asset. Outputs were checked to match float32.
Run:   PYTHONPATH=<site-packages with ultralytics> python tools/export_yoloe.py [weights]
       default weights: yoloe-26s-seg.pt (downloaded by Ultralytics on first use)
Licence: AGPL-3.0 (Ultralytics) – same as YOLO26 already used in the app.
"""
import json, sys
from pathlib import Path

from ultralytics import YOLOE

OUT = Path(__file__).resolve().parent.parent / "public" / "models"
WEIGHTS = sys.argv[1] if len(sys.argv) > 1 else "yoloe-26s-seg.pt"
SIZE = 512  # smaller than 640 → faster in the browser; packages fill a large part of a webcam frame anyway

# Words chosen to cover what people hold into a camera at home; several synonyms per shape help the
# text encoder. All map to "package" in the UI – the brand comes from OCR / barcode / own model / Gemini.
CLASSES = ["snack bag", "chips bag", "food package", "cardboard box", "cereal box", "glass jar", "jar",
           "plastic tub", "yogurt cup", "can", "bottle", "carton", "tube", "chocolate bar", "packet",
           "cosmetics bottle", "lipstick", "perfume bottle", "shoe", "bag", "smartphone", "headphones", "cup",
           "laptop", "book", "watch", "sunglasses", "backpack", "game controller", "camera", "toy"]


def main():
    model = YOLOE(WEIGHTS)
    model.set_classes(CLASSES, model.get_text_pe(CLASSES))
    f = model.export(format="onnx", imgsz=SIZE, simplify=True, opset=17, dynamic=False)
    import onnx
    from onnx import utils
    from onnxruntime.transformers.float16 import convert_float_to_float16
    boxes_only = str(Path(f).with_suffix(".boxes.onnx"))
    utils.extract_model(f, boxes_only, ["images"], ["output0"])  # drop the mask prototypes (output1)
    dst = OUT / "yoloe_pack.onnx"
    onnx.save(convert_float_to_float16(onnx.load(boxes_only), keep_io_types=True), str(dst))
    (OUT / "yoloe_pack.json").write_text(json.dumps({"names": CLASSES, "input": [1, 3, SIZE, SIZE],
                                                     "weights": WEIGHTS, "precision": "float16 weights, float32 io",
                                                     "output": "[1, 4+classes+32, anchors]: cx cy w h (input pixels), class scores (sigmoid), mask coefficients (unused); needs NMS"}, indent=1))
    print("→", dst, dst.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
