import {
  ErrorBoundary as ReactErrorBoundary,
  type FallbackProps,
} from "react-error-boundary";
import type { ReactNode } from "react";

interface SearchErrorBoundaryProps {
  children: ReactNode;
}

/**
 * Catches errors thrown by useQuery (deployment unreachable, server error) and
 * turns them into a recoverable state instead of a blank page.
 */
export function SearchErrorBoundary({ children }: SearchErrorBoundaryProps) {
  return (
    <ReactErrorBoundary FallbackComponent={SearchErrorFallback}>
      {children}
    </ReactErrorBoundary>
  );
}

function SearchErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="error-state" role="alert">
      <p className="error-title">Search is unreachable.</p>
      <p className="error-detail">
        {error instanceof Error ? error.message : "An unknown search error occurred."}
      </p>
      <button type="button" onClick={resetErrorBoundary}>
        Try again
      </button>
    </div>
  );
}
