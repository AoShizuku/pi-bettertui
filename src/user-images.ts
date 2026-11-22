/**
 * Images attached to a user message (DESIGN.md §4.1). The message text ends in a block that the band should not
 * show: pi-editor's reference lines and pi's own resize / conversion notes. This module splits that block off and
 * draws one rail line per image under the band.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

export interface ImageSize {
	width: number;
	height: number;
}

export interface UserImage {
	/** `[Image #N]` number; undefined for an image that came without a pi-editor reference line. */
	id?: number;
	path?: string;
	size?: ImageSize;
	/** Size actually sent, when pi scaled the image down. */
	sent?: ImageSize;
	/** `bmp → png` when pi converted the format. */
	converted?: string;
	/** Why the image did not reach the model, if it did not. */
	notSent?: string;
}

export interface SplitUserMessage {
	body: string;
	images: UserImage[];
}

/** pi-editor: `[Image #N: <path> · <W>×<H> · not attached]` (contract in pi-shizuku README.md). */
const REFERENCE = /^\[Image #(\d+): (.+)\]$/;
/** pi-editor's first format, a Markdown link definition. */
const OLD_REFERENCE = /^\[Image #(\d+)\]: (.+)$/;
/** pi's notes, appended after the prompt when it normalizes images. */
const RESIZED = /^\[Image: original (\d+)x(\d+), displayed at (\d+)x(\d+)\. .*\]$/;
const CONVERTED = /^\[Image converted from (\S+) to (\S+?)\.\]$/;
const OMITTED = /^\[Image omitted: (.*?)\.?\]$/;

const SIZE_FIELD = /^(\d+)×(\d+)$/;

type Trailer =
	| { kind: "reference"; image: UserImage }
	| { kind: "resized"; size: ImageSize; sent: ImageSize }
	| { kind: "converted"; text: string }
	| { kind: "omitted"; reason: string };

function size(width: string | undefined, height: string | undefined): ImageSize {
	return { width: Number(width), height: Number(height) };
}

function shortMime(mime: string | undefined): string {
	return (mime ?? "").replace(/^image\//, "");
}

function omittedReason(reason: string): string {
	if (/size limit/i.test(reason)) return "too large";
	if (/supported .*format/i.test(reason)) return "unsupported format";
	return reason;
}

function parseTrailer(line: string): Trailer | undefined {
	let match = REFERENCE.exec(line);
	if (match) {
		const [path = "", ...fields] = match[2]!.split(" · ");
		const image: UserImage = { id: Number(match[1]), path };
		for (const field of fields) {
			const dims = SIZE_FIELD.exec(field);
			if (dims) image.size = size(dims[1], dims[2]);
			else if (field === "not attached") image.notSent = "model has no image input";
		}
		return { kind: "reference", image };
	}
	match = OLD_REFERENCE.exec(line);
	if (match) return { kind: "reference", image: { id: Number(match[1]), path: match[2]!.trim() } };
	match = RESIZED.exec(line);
	if (match) return { kind: "resized", size: size(match[1], match[2]), sent: size(match[3], match[4]) };
	match = CONVERTED.exec(line);
	if (match) return { kind: "converted", text: `${shortMime(match[1])} → ${shortMime(match[2])}` };
	match = OMITTED.exec(line);
	if (match) return { kind: "omitted", reason: omittedReason(match[1]!) };
	return undefined;
}

function sameSize(a: ImageSize | undefined, b: ImageSize): boolean {
	return a !== undefined && a.width === b.width && a.height === b.height;
}

/**
 * Split the trailing image block off a user message. Returns undefined when the text has no such block, or when
 * nothing would be left for the band.
 */
export function splitUserImages(text: string): SplitUserMessage | undefined {
	const lines = text.split("\n");
	const trailers: Trailer[] = [];
	let end = lines.length;
	while (end > 0) {
		const line = lines[end - 1]!.trim();
		if (line) {
			const trailer = parseTrailer(line);
			if (!trailer) break;
			trailers.unshift(trailer);
		}
		end--;
	}
	if (trailers.length === 0) return undefined;
	const body = lines.slice(0, end).join("\n").trimEnd();
	if (!body.trim()) return undefined;

	const images: UserImage[] = trailers.flatMap((trailer) => (trailer.kind === "reference" ? [trailer.image] : []));
	// pi's notes carry no image number. A lone image owns them all; otherwise a resize note is matched by the
	// original size pi-editor recorded, and anything that cannot be placed gets a line of its own.
	const lone = images.length === 1 ? images[0] : undefined;
	for (const trailer of trailers) {
		if (trailer.kind === "reference") continue;
		if (trailer.kind === "resized") {
			const owner =
				images.find((image) => image.sent === undefined && sameSize(image.size, trailer.size)) ??
				(lone && lone.sent === undefined && lone.size === undefined ? lone : undefined);
			if (owner) {
				owner.size ??= trailer.size;
				owner.sent = trailer.sent;
			} else {
				images.push({ size: trailer.size, sent: trailer.sent });
			}
		} else if (trailer.kind === "converted") {
			if (lone) lone.converted = trailer.text;
			else images.push({ converted: trailer.text });
		} else if (lone) {
			lone.notSent = trailer.reason;
		} else {
			images.push({ notSent: trailer.reason });
		}
	}
	return { body, images };
}

function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function formatSize(value: ImageSize): string {
	return `${value.width}×${value.height}`;
}

/** One rail line per image, under the user message band and without its background. */
export class UserImageLines implements Component {
	private readonly present: boolean[];

	constructor(
		private readonly images: readonly UserImage[],
		private readonly getTheme: () => Theme,
		exists: (path: string) => boolean = existsSync,
	) {
		// Checked once per rebuild: clipboard files live in the temp dir and may be gone when history is replayed.
		this.present = images.map((image) => image.path === undefined || exists(image.path));
	}

	render(width: number): string[] {
		const theme = this.getTheme();
		return this.images.map((image, index) => {
			const rail = theme.fg("dim", `  ${index === this.images.length - 1 ? "└" : "├"} `);
			const name = image.id === undefined ? "Image" : `Image #${image.id}`;
			const linked = image.path && this.present[index] ? hyperlink(pathToFileURL(image.path).href, name) : name;

			const details: string[] = [];
			if (image.size) details.push(image.sent ? `${formatSize(image.size)} → ${formatSize(image.sent)}` : formatSize(image.size));
			else if (image.sent) details.push(`→ ${formatSize(image.sent)}`);
			if (image.converted) details.push(image.converted);
			const warnings: string[] = [];
			if (image.notSent) warnings.push(`not sent · ${image.notSent}`);
			if (!this.present[index]) warnings.push("file removed");

			const detailText = details.map((detail) => theme.fg("dim", ` · ${detail}`)).join("");
			const warningText = warnings.map((warning) => theme.fg("warning", ` · ${warning}`)).join("");
			return truncateToWidth(`${rail}${theme.fg("muted", linked)}${detailText}${warningText}`, width, "…");
		});
	}

	invalidate(): void {}
}
