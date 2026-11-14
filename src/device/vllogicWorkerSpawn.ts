// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Gives `workerVllogicDevice` the browser's constructor for `vllogicWorker.ts`.
 *
 * Only the browser entry imports this: the `?worker&inline` specifier is a Vite build
 * feature, and the offline suite bundles the device layer with plain esbuild.
 */

import VllogicWorker from './vllogicWorker.ts?worker&inline';
import { installVllogicWorkerSpawn } from './workerVllogicDevice.js';

installVllogicWorkerSpawn(() => new VllogicWorker() as unknown as Worker);
