export function BrandWordmark({ className = "" }: { className?: string }) {
	return (
		<svg className={`brand-wordmark ${className}`.trim()} viewBox="421 249 1384 205"
			preserveAspectRatio="xMinYMid slice" role="img" aria-label="pi-harness" focusable="false">
			<path fill="var(--brand-coral)" d="M421 260h156v98h-52v-50H421z" />
			<path fill="var(--brand-blue)" d="M421 308h52v50h52v47h-52v49h-52z" />
			<path fill="var(--brand-gold)" d="M577 358h52v96h-52z" />
			<path fill="var(--wordmark-blue)" d="M685 353h68v30h-68z" />
			<g fill="var(--wordmark-coral)" fillRule="evenodd">
				<path d="M773 249h39v58h85l8 8v139h-39V342h-54v112h-39z" />
				<path d="M930 307h132v147H938l-8-8v-75l8-8h84v-21h-92z M969 396v23h53v-23z" />
				<path d="M1087 307h40v9l9-9h64v35h-73v112h-40z" />
			</g>
			<g fill="var(--wordmark-blue)" fillRule="evenodd">
				<path d="M1225 307h132v147h-39V342h-54v112h-39z" />
				<path d="M1383 307h130v89h-92v23h92v35h-122l-8-8z M1421 342v21h53v-21z" />
			</g>
			<g fill="var(--wordmark-gold)">
				<path d="M1539 316l9-9h109v34h-80v22h80v91h-118v-35h80v-23h-71l-9-9z" />
				<path d="M1684 307h121v34h-82v22h79l3 3v88h-121v-35h80v-23h-71l-9-9z" />
			</g>
		</svg>
	);
}
