import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ImageContent } from "../../../../shared/types";
import { t } from "../../i18n";

/** 会话图片按视口懒解码，避免离屏 base64 图片提前占用位图内存。 */
export function MessageImage(props: {
	src: string;
	alt: string;
	className: string;
	onClick?: () => void;
	placeholderClass?: string;
}) {
	const ref = useRef<HTMLImageElement>(null);
	const [inView, setInView] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					setInView(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (
		<img
			ref={ref}
			src={inView ? props.src : undefined}
			alt={props.alt}
			className={`${props.className}${!inView && props.placeholderClass ? ` ${props.placeholderClass}` : ""}`}
			loading="lazy"
			decoding="async"
			onClick={props.onClick}
		/>
	);
}

/** 全屏图片预览层。 */
export function ImagePreviewModal(props: {
	image: ImageContent;
	onClose: () => void;
}) {
	return (
		<div className="image-preview-modal" onClick={props.onClose}>
			<button
				className="image-preview-close"
				onClick={props.onClose}
				aria-label={t("app.imagePreviewClose")}
			>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img
				src={`data:${props.image.mimeType};base64,${props.image.data}`}
				alt={t("app.imagePreviewAlt")}
				onClick={(event) => event.stopPropagation()}
			/>
		</div>
	);
}
