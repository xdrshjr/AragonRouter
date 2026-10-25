import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose conditional class names and let `tailwind-merge` resolve conflicts.
 * The last conflicting utility wins, so a caller can always override a default
 * (for example `className="w-full"` on a `Button` that ships `w-auto`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
