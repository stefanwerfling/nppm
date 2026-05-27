/**
 * Drag-to-resize vertical splitter between the treeview and the main
 * content area. Keeps the controls element's width in CSS pixels and
 * clamps to a sane range.
 */
export class Resizer {

    private readonly _handle: HTMLElement;
    private readonly _target: HTMLElement;
    private readonly _min: number;
    private readonly _max: number;

    constructor(handle: HTMLElement, target: HTMLElement, min = 160, max = 600) {
        this._handle = handle;
        this._target = target;
        this._min = min;
        this._max = max;
        this._bind();
    }

    private _bind(): void {
        this._handle.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            const startX = ev.clientX;
            const startWidth = this._target.getBoundingClientRect().width;

            const onMove = (e: MouseEvent): void => {
                const next = Math.min(
                    this._max,
                    Math.max(this._min, startWidth + (e.clientX - startX))
                );
                this._target.style.width = `${next}px`;
            };

            const onUp = (): void => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };

            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    }
}