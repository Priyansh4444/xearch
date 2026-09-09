import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

function SearchErrorFallback({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}): ReactNode {
  return (
    <div className="error-state" role="alert">
      <p className="error-title">Search is unreachable.</p>
      <p className="error-detail">{error.message}</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/**
 * React still requires a class component for error boundaries.
 * The fallback UI is a functional component; this shell only owns error state.
 */
export class SearchErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <SearchErrorFallback
        error={this.state.error}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}
