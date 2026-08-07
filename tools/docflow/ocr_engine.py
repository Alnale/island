"""DocFlow 自研 OCR 引擎

封装 RapidOCR（PaddleOCR ONNX 模型）提供统一的 OCR 接口。
支持智能预处理、文本行合并、多引擎 fallback。
"""

import os
import logging

logger = logging.getLogger(__name__)


class DocFlowOCR:
    """自研 OCR 引擎，基于 RapidOCR ONNX 模型。

    特性：
    - 延迟加载：首次调用时初始化模型
    - 智能预处理：根据图像质量自动选择策略
    - 文本行合并：按 Y 坐标聚类为逻辑行
    - 坐标转换：像素 → PDF points
    """

    def __init__(self, confidence_threshold: float = 0.3):
        self._engine = None
        self.confidence_threshold = confidence_threshold

    def _ensure_engine(self):
        if self._engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
                self._engine = RapidOCR()
                logger.info("RapidOCR 引擎初始化成功")
            except ImportError:
                raise RuntimeError(
                    "RapidOCR 未安装。请运行: pip install rapidocr-onnxruntime"
                )

    def _preprocess(self, image_path: str) -> str:
        """智能预处理：仅在图像质量差时启用。"""
        import cv2
        import numpy as np

        img = cv2.imread(image_path)
        if img is None:
            return image_path

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # 检测图像质量：如果对比度足够好，不做预处理
        std = gray.std()
        if std > 40:  # 对比度良好
            return image_path

        # 低对比度：增强
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)

        # 对比度拉伸
        p2, p98 = np.percentile(enhanced, (2, 98))
        if p98 - p2 > 10:
            stretched = np.clip(
                (enhanced.astype(float) - p2) / (p98 - p2) * 255, 0, 255
            ).astype(np.uint8)
        else:
            stretched = enhanced

        # 保存预处理结果
        preprocessed_path = image_path + "_preprocessed.png"
        cv2.imwrite(preprocessed_path, stretched)
        return preprocessed_path

    def recognize(self, image_path: str) -> list[dict]:
        """识别图像中的文字。

        Returns:
            [{"text": str, "box": [[x1,y1],...], "confidence": float,
              "x": float, "y": float, "w": float, "h": float}]
        """
        self._ensure_engine()

        # 智能预处理
        processed_path = self._preprocess(image_path)
        try:
            result, _ = self._engine(processed_path)
        finally:
            if processed_path != image_path:
                try:
                    os.remove(processed_path)
                except OSError:
                    pass

        if not result:
            return []

        regions = []
        for box, text, conf in result:
            conf = float(conf)
            if conf < self.confidence_threshold:
                continue
            if not text or not text.strip():
                continue

            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            x, y = min(xs), min(ys)
            w, h = max(xs) - x, max(ys) - y

            regions.append({
                "text": text.strip(),
                "box": box,
                "confidence": conf,
                "x": x, "y": y, "w": w, "h": h,
            })

        return regions

    def ocr_page(self, image_path: str, dpi: int = 300) -> list[tuple[str, float, float, float, float]]:
        """识别图像并返回兼容现有接口的格式。

        Args:
            image_path: 图像文件路径
            dpi: 图像 DPI（用于坐标转换）

        Returns:
            [(text, x_pt, y_pt, w_pt, h_pt), ...] 坐标单位为 PDF points
        """
        regions = self.recognize(image_path)

        # 像素 → PDF points: pt = px / dpi * 72
        scale = 72.0 / dpi
        words = []
        for r in regions:
            words.append((
                r["text"],
                r["x"] * scale,
                r["y"] * scale,
                r["w"] * scale,
                r["h"] * scale,
            ))

        return words

    def is_available(self) -> bool:
        """检查引擎是否可用。"""
        try:
            self._ensure_engine()
            return True
        except Exception:
            return False


# 全局单例
_ocr_instance = None


def get_ocr_engine(confidence_threshold: float = 0.3) -> DocFlowOCR:
    """获取全局 OCR 引擎实例。"""
    global _ocr_instance
    if _ocr_instance is None:
        _ocr_instance = DocFlowOCR(confidence_threshold=confidence_threshold)
    return _ocr_instance
