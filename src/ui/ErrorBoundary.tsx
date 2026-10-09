// A render error in one part of the window used to unmount the whole React
// tree and leave the plugin blank. Boundaries keep the rest working, show what
// broke, and report it through figma.notify.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { send } from "./common";
import { WarningIcon } from "./icons";

interface Props {
  children: ReactNode;
  /** Changing it (another tab, a new result) clears the error. */
  resetKey?: unknown;
  /** What was being shown, for the message. */
  area: string;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`GoApp Figma: ${this.props.area} failed`, error, info.componentStack);
    send({ type: "notify", message: `GoApp Figma: ${this.props.area} failed: ${error.message}` });
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty">
        <div className="empty-card danger">
          <span className="empty-tile">
            <WarningIcon />
          </span>
          <h2>{this.props.area} failed</h2>
          <p>{error.message || String(error)}</p>
          <button className="btn-utility retry" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
