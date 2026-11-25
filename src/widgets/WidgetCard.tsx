import type { DragEvent, ReactNode } from "react";
import { Icon } from "../ui/Icon.tsx";

export interface WidgetCardProps {
  id: string;
  title: string;
  index: number;
  count: number;
  wide?: boolean;
  tall?: boolean;
  status?: ReactNode;
  actions?: ReactNode;
  onMove: (to: number) => void;
  onRemove: () => void;
  onDropWidget: (draggedId: string) => void;
  children: ReactNode;
}

/** A widget's frame: title, status line, its own actions, and reorder/remove controls. */
export function WidgetCard(props: WidgetCardProps) {
  const { id, title, index, count, wide, tall, status, actions, onMove, onRemove, onDropWidget, children } = props;
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData("text/x-rlx-widget", id);
    event.dataTransfer.effectAllowed = "move";
  };
  const onDrop = (event: DragEvent) => {
    const dragged = event.dataTransfer.getData("text/x-rlx-widget");
    if (dragged && dragged !== id) {
      event.preventDefault();
      onDropWidget(dragged);
    }
  };
  return (
    <section
      className={`widget reveal-host${wide ? " widget--wide" : ""}${tall ? " widget--tall" : ""}`}
      aria-label={title}
      data-widget-id={id}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <header className="widget__header" draggable onDragStart={onDragStart}>
        <h3 className="widget__title">{title}</h3>
        <div className="widget__tools reveal">
          {actions}
          <button type="button" className="icon-button icon-button--sm" aria-label={`Move ${title} earlier`} disabled={index === 0} onClick={() => onMove(index - 1)}>
            <Icon name="left" size={16} />
          </button>
          <button type="button" className="icon-button icon-button--sm" aria-label={`Move ${title} later`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
            <Icon name="right" size={16} />
          </button>
          <button type="button" className="icon-button icon-button--sm" aria-label={`Remove ${title}`} onClick={onRemove}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>
      {status ? <p className="widget__status">{status}</p> : null}
      <div className="widget__body">{children}</div>
    </section>
  );
}
