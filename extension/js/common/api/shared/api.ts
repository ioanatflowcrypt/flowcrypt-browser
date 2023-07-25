/* ©️ 2016 - present FlowCrypt a.s. Limitations apply. Contact human@flowcrypt.com */

'use strict';

import { Attachment } from '../../core/attachment.js';
import { BrowserMsg } from '../../browser/browser-msg.js';
import { Buf } from '../../core/buf.js';
import { Catch } from '../../platform/catch.js';
import { Dict, EmailParts } from '../../core/common.js';
import { Env } from '../../browser/env.js';
import { secureRandomBytes } from '../../platform/util.js';
import { ApiErr, AjaxErr } from './api-error.js';

export type ReqFmt = 'JSON' | 'FORM' | 'TEXT';
export type RecipientType = 'to' | 'cc' | 'bcc';
type ResFmt = 'json' | 'xhr';
export type ReqMethod = 'POST' | 'GET' | 'DELETE' | 'PUT';
export type EmailProviderContact = EmailParts;
type ProviderContactsResults = { new: EmailProviderContact[]; all: EmailProviderContact[] };
type RawAjaxErr = {
  // getAllResponseHeaders?: () => any,
  // getResponseHeader?: (e: string) => any,
  readyState: number;
  responseText?: string;
  status?: number;
  statusText?: string;
};
export type ProgressDestFrame = { operationId: string; expectedTransferSize: number; tabId?: string };
export type ApiCallContext = ProgressDestFrame | undefined;

export type ChunkedCb = (r: ProviderContactsResults) => Promise<void>;
export type ProgressCb = (percent: number | undefined, loaded: number, total: number) => void;
export type ProgressCbs = { upload?: ProgressCb | null; download?: ProgressCb | null };

export class Api {
  public static download = async (url: string, progress?: ProgressCb, timeout?: number): Promise<Buf> => {
    return await new Promise((resolve, reject) => {
      Api.throwIfApiPathTraversalAttempted(url);
      const request = new XMLHttpRequest();
      if (timeout) {
        request.timeout = timeout * 1000;
      }
      request.open('GET', url, true);
      request.responseType = 'arraybuffer';
      if (typeof progress === 'function') {
        request.onprogress = evt => progress(evt.lengthComputable ? Math.floor((evt.loaded / evt.total) * 100) : undefined, evt.loaded, evt.total);
      }
      const errHandler = (progressEvent: ProgressEvent<EventTarget>) => {
        if (!progressEvent.target) {
          reject(new Error(`Api.download(${url}) failed with a null progressEvent.target`));
        } else {
          const { readyState, status, statusText } = progressEvent.target as XMLHttpRequest;
          reject(AjaxErr.fromXhr({ readyState, status, statusText }, { url, method: 'GET' }, Catch.stackTrace()));
        }
      };
      request.onerror = errHandler;
      request.ontimeout = errHandler;
      request.onload = e => (request.status <= 299 ? resolve(new Buf(request.response as ArrayBuffer)) : errHandler(e));
      request.send();
    });
  };

  public static ajax = async (req: JQuery.AjaxSettings<ApiCallContext>, stack: string): Promise<unknown | JQuery.jqXHR<unknown>> => {
    if (Env.isContentScript()) {
      // content script CORS not allowed anymore, have to drag it through background page
      // https://www.chromestatus.com/feature/5629709824032768
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return await BrowserMsg.send.bg.await.ajax({ req, stack });
    }
    try {
      return await new Promise((resolve, reject) => {
        Api.throwIfApiPathTraversalAttempted(req.url || '');
        $.ajax({ ...req, dataType: req.dataType === 'xhr' ? undefined : req.dataType })
          .then((data, s, xhr) => {
            if (req.dataType === 'xhr') {
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore -> prevent the xhr object from getting further "resolved" and processed by jQuery, below
              xhr.then = xhr.promise = undefined;
              resolve(xhr);
            } else {
              resolve(data as unknown);
            }
          })
          .catch(reject);
      });
    } catch (e) {
      if (e instanceof Error) {
        throw e;
      }
      if (Api.isRawAjaxErr(e)) {
        throw AjaxErr.fromXhr(e, req, stack);
      }
      throw new Error(`Unknown Ajax error (${String(e)}) type when calling ${req.url}`);
    }
  };

  public static isInternetAccessible = async () => {
    try {
      await Api.download('https://google.com');
      return true;
    } catch (e) {
      if (ApiErr.isNetErr(e)) {
        return false;
      }
      throw e;
    }
  };

  public static getAjaxProgressXhrFactory = (progressCbs: ProgressCbs | undefined): (() => XMLHttpRequest) | undefined => {
    if (Env.isContentScript() || !progressCbs || !(progressCbs.upload || progressCbs.download)) {
      // xhr object would cause 'The object could not be cloned.' lastError during BrowserMsg passing
      // thus no progress callbacks in bg or content scripts
      // additionally no need to create this if there are no progressCbs defined
      return undefined;
    }
    return () => {
      // returning a factory
      let lastProgressPercent = -1;
      const progressPeportingXhr = new XMLHttpRequest();
      if (progressCbs && typeof progressCbs.upload === 'function') {
        progressPeportingXhr.upload.addEventListener(
          'progress',
          (evt: ProgressEvent) => {
            const newProgressPercent = evt.lengthComputable ? Math.round((evt.loaded / evt.total) * 100) : undefined;
            if (newProgressPercent && newProgressPercent !== lastProgressPercent) {
              lastProgressPercent = newProgressPercent;
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              progressCbs.upload!(newProgressPercent, evt.loaded, evt.total); // checked ===function above
            }
          },
          false
        );
      }
      if (progressCbs && typeof progressCbs.download === 'function') {
        progressPeportingXhr.addEventListener('progress', (evt: ProgressEvent) => {
          // 100 because if the request takes less time than 1-2 seconds browsers trigger this function only once and when it's completed
          const newProgressPercent = evt.lengthComputable ? Math.floor((evt.loaded / evt.total) * 100) : undefined;
          if (typeof newProgressPercent === 'undefined' || newProgressPercent !== lastProgressPercent) {
            if (newProgressPercent) {
              lastProgressPercent = newProgressPercent;
            }
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            progressCbs.download!(newProgressPercent, evt.loaded, evt.total); // checked ===function above
          }
        });
      }
      return progressPeportingXhr;
    };
  };

  public static randomFortyHexChars = (): string => {
    const bytes = Array.from(secureRandomBytes(20));
    return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  };

  public static isRecipientHeaderNameType = (value: string): value is 'to' | 'cc' | 'bcc' => {
    return ['to', 'cc', 'bcc'].includes(value);
  };

  protected static apiCall = async <RT>(
    url: string,
    path: string,
    fields?: Dict<unknown> | string,
    fmt?: ReqFmt,
    progress?: ProgressCbs,
    headers?: Dict<string>,
    resFmt: ResFmt = 'json',
    method: ReqMethod = 'POST'
  ): Promise<RT> => {
    progress = progress || ({} as ProgressCbs);
    let formattedData: FormData | string | undefined;
    let contentType: string | false;
    if (fmt === 'JSON' && fields) {
      formattedData = JSON.stringify(fields);
      contentType = 'application/json; charset=UTF-8';
    } else if (fmt === 'TEXT' && typeof fields === 'string') {
      formattedData = fields;
      contentType = false;
    } else if (fmt === 'FORM' && fields && typeof fields !== 'string') {
      formattedData = new FormData();
      for (const formFieldName of Object.keys(fields)) {
        const a: Attachment | string = fields[formFieldName] as Attachment | string;
        if (a instanceof Attachment) {
          formattedData.append(formFieldName, new Blob([a.getData()], { type: a.type }), a.name); // xss-none
        } else {
          formattedData.append(formFieldName, a); // xss-none
        }
      }
      contentType = false;
    } else if (!fmt && !fields && method === 'GET') {
      formattedData = undefined;
      contentType = false;
    } else {
      throw new Error('unknown format:' + String(fmt));
    }
    const req: JQuery.AjaxSettings<ApiCallContext> = {
      xhr: Api.getAjaxProgressXhrFactory(progress),
      url: url + path,
      method,
      data: formattedData,
      dataType: resFmt,
      crossDomain: true,
      headers,
      processData: false,
      contentType,
      async: true,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      timeout: typeof progress!.upload === 'function' || typeof progress!.download === 'function' ? undefined : 20000, // substituted with {} above
    };
    const res = await Api.ajax(req, Catch.stackTrace());
    return res as RT;
  };

  private static isRawAjaxErr = (e: unknown): e is RawAjaxErr => {
    return !!e && typeof e === 'object' && typeof (e as RawAjaxErr).readyState === 'number';
  };

  /**
   * Security check, in case attacker modifies parameters which are then used in an url
   * https://github.com/FlowCrypt/flowcrypt-browser/issues/2646
   */
  private static throwIfApiPathTraversalAttempted = (requestUrl: string) => {
    if (requestUrl.includes('../') || requestUrl.includes('/..')) {
      throw new Error(`API path traversal forbidden: ${requestUrl}`);
    }
  };
}
