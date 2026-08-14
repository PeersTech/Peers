import {useEffect, useRef} from 'react';
import {DialogController} from '../lib/dialogs';

export function useDialog() {
    const controllerRef = useRef<DialogController | null>(null);
    if (!controllerRef.current) controllerRef.current = new DialogController();
    const controller = controllerRef.current;

    useEffect(() => () => controller.destroy(), [controller]);

    return {
        controller,
        confirm: controller.confirm,
        prompt: controller.prompt,
        showText: controller.showText,
    };
}
