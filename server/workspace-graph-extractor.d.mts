import type ts from "typescript";
export interface ExtractInput { text: string; sha256: string }
export interface ExtractAnchor { source: string; path: string; owner?: string; ownerOffset?: number; line: number; endLine: number; sha256: string; role?: string }
export interface EventFlow {
	value: string;
	target: string;
	emit: ExtractAnchor;
	write: ExtractAnchor;
	anchors: ExtractAnchor[];
}
export interface PackageLink { specifier: string; binding: string; typeOnly: boolean; operation: string; anchors: ExtractAnchor[] }
export function packageResolver(files: Map<string, ExtractInput>): (specifier: string, importer: string) => string | undefined;
export function analyze(files: Map<string, ExtractInput>, parsed: Map<string, ts.SourceFile>, maximumPaths?: number, includePackageLinks?: boolean): { paths: EventFlow[]; candidates: unknown[]; packages: PackageLink[] };
