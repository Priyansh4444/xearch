import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * Catches errors thrown by useQuery (deployment unreachable, server error) and
 * turns them into a recoverable state instead of a blank page.
 */
export class SearchErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="error-state" role="alert">
        <p className="error-title">Search is unreachable.</p>
        <p className="error-detail">{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
