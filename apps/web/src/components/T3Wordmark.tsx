import type { SVGProps } from "react";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(-45 12 12)" fill="currentColor">
        <path d="M2.6 9H5.8V15H2.6C1.937 15 1.4 14.463 1.4 13.8V10.2C1.4 9.537 1.937 9 2.6 9Z" />
        <path d="M7 9H17V15H7V9Z" />
        <path d="M18.2 9H21.4C22.063 9 22.6 9.537 22.6 10.2V13.8C22.6 14.463 22.063 15 21.4 15H18.2V9Z" />
      </g>
    </svg>
  );
}
