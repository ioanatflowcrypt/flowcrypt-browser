/* ©️ 2016 - present FlowCrypt a.s. Limitations apply. Contact human@flowcrypt.com */

'use strict';

import { Url } from '../../../core/common.js';
import { FLAVOR, GOOGLE_OAUTH_SCREEN_HOST, OAUTH_GOOGLE_API_HOST } from '../../../core/const.js';
import { ApiErr } from '../../shared/api-error.js';
import { Ajax, Api } from '../../shared/api.js';

import { Bm, GoogleAuthWindowResult$result } from '../../../browser/browser-msg.js';
import { InMemoryStoreKeys } from '../../../core/const.js';
import { OAuth2 } from '../../../oauth2/oauth2.js';
import { Catch } from '../../../platform/catch.js';
import { AcctStore, AcctStoreDict } from '../../../platform/store/acct-store.js';
import { InMemoryStore } from '../../../platform/store/in-memory-store.js';
import { AccountServer } from '../../account-server.js';
import { OAuth } from '../generic/oauth.js';
import { ExternalService } from '../../account-servers/external-service.js';
import { GoogleAuthErr } from '../../shared/api-error.js';
import { Assert, AssertError } from '../../../assert.js';

/* eslint-disable @typescript-eslint/naming-convention */
type GoogleAuthTokensResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token: string;
  token_type: 'Bearer';
};
type AuthResultSuccess = { result: 'Success'; acctEmail: string; id_token: string; error?: undefined };
type AuthResultError = {
  result: GoogleAuthWindowResult$result;
  acctEmail?: string;
  error?: string;
  id_token: undefined;
};

type AuthReq = { acctEmail?: string; scopes: string[]; messageId?: string; expectedState: string };
type GoogleTokenInfo = { email: string; scope: string; expires_in: number; token_type: string };
export type AuthRes = AuthResultSuccess | AuthResultError;
/* eslint-enable @typescript-eslint/naming-convention */

export class GoogleOAuth extends OAuth {
  /* eslint-disable @typescript-eslint/naming-convention */
  public static OAUTH = {
    client_id: '717284730244-5oejn54f10gnrektjdc4fv4rbic1bj1p.apps.googleusercontent.com',
    client_secret: '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',
    redirect_uri: 'https://www.google.com/robots.txt',
    url_code: `${GOOGLE_OAUTH_SCREEN_HOST}/o/oauth2/auth`,
    url_tokens: `${OAUTH_GOOGLE_API_HOST}/token`,
    state_header: 'CRYPTUP_STATE_',
    scopes: {
      email: 'email',
      openid: 'openid',
      profile: 'https://www.googleapis.com/auth/userinfo.profile', // needed so that `name` is present in `id_token`, which is required for key-server auth when in use
      compose: 'https://www.googleapis.com/auth/gmail.compose',
      modify: 'https://www.googleapis.com/auth/gmail.modify',
      readContacts: 'https://www.googleapis.com/auth/contacts.readonly',
      readOtherContacts: 'https://www.googleapis.com/auth/contacts.other.readonly',
    },
    legacy_scopes: {
      gmail: 'https://mail.google.com/', // causes a freakish oauth warn: "can permannently delete all your email" ...
    },
  };
  /* eslint-enable @typescript-eslint/naming-convention */

  public static defaultScopes = (group: 'default' | 'contacts' = 'default') => {
    const { readContacts, readOtherContacts, compose, modify, openid, email, profile } = GoogleOAuth.OAUTH.scopes;
    if (group === 'default') {
      if (FLAVOR === 'consumer') {
        return [openid, email, profile, compose, modify]; // consumer may freak out that extension asks for their contacts early on
      } else if (FLAVOR === 'enterprise') {
        return [openid, email, profile, compose, modify, readContacts, readOtherContacts]; // enterprise expects their contact search to work properly
      } else {
        throw new Error(`Unknown build ${FLAVOR}`);
      }
    } else if (group === 'contacts') {
      return [openid, email, profile, compose, modify, readContacts, readOtherContacts];
    } else {
      throw new Error(`Unknown scope group ${group}`);
    }
  };

  public static getTokenInfo = async (accessToken: string): Promise<GoogleTokenInfo> => {
    return (await Api.ajax(
      {
        url: `${OAUTH_GOOGLE_API_HOST}/tokeninfo?access_token=${accessToken}`,
        method: 'GET',
        timeout: 10000,
        stack: Catch.stackTrace(),
      },
      'json'
    )) as GoogleTokenInfo;
  };

  public static googleApiAuthHeader = async (acctEmail: string, forceRefresh = false): Promise<string> => {
    if (!acctEmail) {
      throw new Error('missing account_email in api_gmail_call');
    }
    const { google_token_refresh } = await AcctStore.get(acctEmail, ['google_token_refresh']); // eslint-disable-line @typescript-eslint/naming-convention
    if (!google_token_refresh) {
      throw new GoogleAuthErr(`Account ${acctEmail} not connected to FlowCrypt Browser Extension`);
    }
    if (!forceRefresh) {
      const googleAccessToken = await InMemoryStore.get(acctEmail, InMemoryStoreKeys.GOOGLE_TOKEN_ACCESS);
      if (googleAccessToken) {
        return `Bearer ${googleAccessToken}`;
      }
    }
    // refresh token
    const refreshTokenRes = await GoogleOAuth.googleAuthRefreshToken(google_token_refresh);
    if (refreshTokenRes.access_token) {
      await GoogleOAuth.googleAuthSaveTokens(acctEmail, refreshTokenRes);
      const googleAccessToken = await InMemoryStore.get(acctEmail, InMemoryStoreKeys.GOOGLE_TOKEN_ACCESS);
      if (googleAccessToken) {
        return `Bearer ${googleAccessToken}`;
      }
    }
    throw new GoogleAuthErr(
      `Could not refresh google auth token - did not become valid (access:${refreshTokenRes.access_token},expires_in:${
        refreshTokenRes.expires_in
      },now:${Date.now()})`
    );
  };

  public static apiGoogleCallRetryAuthErrorOneTime = async <RT>(acctEmail: string, req: Ajax): Promise<RT> => {
    try {
      return (await Api.ajax(req, 'json')) as RT;
    } catch (firstAttemptErr) {
      if (ApiErr.isAuthErr(firstAttemptErr)) {
        // force refresh token
        return (await Api.ajax(
          { ...req, headers: { ...(req.headers ?? {}), authorization: await GoogleOAuth.googleApiAuthHeader(acctEmail, true) }, stack: Catch.stackTrace() },
          'json'
        )) as RT;
      }
      throw firstAttemptErr;
    }
  };

  public static newAuthPopup = async ({ acctEmail, scopes, save }: { acctEmail?: string; scopes?: string[]; save?: boolean }): Promise<AuthRes> => {
    if (acctEmail) {
      acctEmail = acctEmail.toLowerCase();
    }
    if (typeof save === 'undefined') {
      save = true;
    }
    if (save || !scopes) {
      // if tokens will be saved (meaning also scopes should be pulled from storage) or if no scopes supplied
      scopes = await GoogleOAuth.apiGoogleAuthPopupPrepareAuthReqScopes(scopes || GoogleOAuth.defaultScopes());
    }
    const authRequest = GoogleOAuth.newAuthRequest(acctEmail, scopes);
    const authUrl = GoogleOAuth.apiGoogleAuthCodeUrl(authRequest);
    const authWindowResult = await OAuth2.webAuthFlow(authUrl);
    const authRes = await GoogleOAuth.getAuthRes({
      acctEmail,
      save,
      requestedScopes: scopes,
      expectedState: authRequest.expectedState,
      authWindowResult,
    });
    if (authRes.result === 'Success') {
      if (!authRes.id_token) {
        return {
          result: 'Error',
          error: 'Grant was successful but missing id_token',
          acctEmail: authRes.acctEmail,
          id_token: undefined, // eslint-disable-line @typescript-eslint/naming-convention
        };
      }
      if (!authRes.acctEmail) {
        return {
          result: 'Error',
          error: 'Grant was successful but missing acctEmail',
          acctEmail: authRes.acctEmail,
          id_token: undefined, // eslint-disable-line @typescript-eslint/naming-convention
        };
      }
      try {
        const potentialFes = new ExternalService(authRes.acctEmail);
        if (await potentialFes.isFesInstalledAndAvailable()) {
          await AcctStore.set(authRes.acctEmail, { fesUrl: potentialFes.url });
        }
        // fetch and store ClientConfiguration (not authenticated)
        await (await AccountServer.init(authRes.acctEmail)).fetchAndSaveClientConfiguration();
      } catch (e) {
        if (GoogleOAuth.isFesUnreachableErr(e, authRes.acctEmail)) {
          const error = `Cannot reach your company's FlowCrypt External Service (FES). Contact your Help Desk when unsure. (${String(e)})`;
          return { result: 'Error', error, acctEmail: authRes.acctEmail, id_token: undefined }; // eslint-disable-line @typescript-eslint/naming-convention
        }
        return {
          result: 'Error',
          error: `Grant successful but error accessing fc account: ${String(e)}`,
          acctEmail: authRes.acctEmail,
          id_token: undefined, // eslint-disable-line @typescript-eslint/naming-convention
        };
      }
    }
    return authRes;
  };

  private static getAuthRes = async ({
    acctEmail,
    save,
    requestedScopes,
    expectedState,
    authWindowResult,
  }: {
    acctEmail?: string;
    save: boolean;
    requestedScopes: string[];
    expectedState: string;
    authWindowResult: Bm.AuthWindowResult;
  }): Promise<AuthRes> => {
    /* eslint-disable @typescript-eslint/naming-convention */
    try {
      if (!authWindowResult.url) {
        return { acctEmail, result: 'Denied', error: 'Invalid response url', id_token: undefined };
      }
      if (authWindowResult.error) {
        return { acctEmail, result: 'Denied', error: authWindowResult.error, id_token: undefined };
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const uncheckedUrlParams = Url.parse(['scope', 'code', 'state'], authWindowResult.url!);
      const allowedScopes = Assert.urlParamRequire.string(uncheckedUrlParams, 'scope');
      const code = Assert.urlParamRequire.optionalString(uncheckedUrlParams, 'code');
      const receivedState = Assert.urlParamRequire.string(uncheckedUrlParams, 'state');
      const scopesToCheck = [this.OAUTH.scopes.compose, this.OAUTH.scopes.modify, this.OAUTH.scopes.readContacts, this.OAUTH.scopes.readOtherContacts];
      for (const scopeToCheck of scopesToCheck) {
        if (requestedScopes.includes(scopeToCheck) && !allowedScopes?.includes(scopeToCheck)) {
          return { acctEmail, result: 'Denied', error: 'Missing permissions', id_token: undefined };
        }
      }
      if (!code) {
        return {
          acctEmail,
          result: 'Denied',
          error: "Google auth result was 'Success' but no auth code",
          id_token: undefined,
        };
      }
      if (receivedState !== expectedState) {
        return { acctEmail, result: 'Error', error: `Wrong oauth CSRF token. Please try again.`, id_token: undefined };
      }
      const { id_token } = save ? await GoogleOAuth.retrieveAndSaveAuthToken(code) : await GoogleOAuth.googleAuthGetTokens(code);
      const { email } = GoogleOAuth.parseIdToken(id_token);
      if (!email) {
        throw new Error('Missing email address in id_token');
      }
      return { acctEmail: email, result: 'Success', id_token };
    } catch (err) {
      if (err instanceof AssertError) {
        return { acctEmail, result: 'Error', error: 'Could not parse URL returned from Google', id_token: undefined };
      }
      return { acctEmail, result: 'Denied', error: String(err), id_token: undefined };
    }
    /* eslint-enable @typescript-eslint/naming-convention */
  };

  private static newAuthRequest = (acctEmail: string | undefined, scopes: string[]): AuthReq => {
    const authReq = {
      acctEmail,
      scopes,
      csrfToken: `csrf-${Api.randomFortyHexChars()}`,
    };
    return {
      ...authReq,
      expectedState: GoogleOAuth.OAUTH.state_header + JSON.stringify(authReq),
    };
  };

  private static apiGoogleAuthCodeUrl = (authReq: AuthReq) => {
    /* eslint-disable @typescript-eslint/naming-convention */
    return Url.create(GoogleOAuth.OAUTH.url_code, {
      client_id: GoogleOAuth.OAUTH.client_id,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state: authReq.expectedState,
      redirect_uri: GoogleOAuth.OAUTH.redirect_uri,
      scope: (authReq.scopes || []).join(' '),
      login_hint: authReq.acctEmail,
    });
    /* eslint-enable @typescript-eslint/naming-convention */
  };

  private static googleAuthSaveTokens = async (acctEmail: string, tokensObj: GoogleAuthTokensResponse) => {
    const parsedOpenId = GoogleOAuth.parseIdToken(tokensObj.id_token);
    const { full_name, picture } = await AcctStore.get(acctEmail, ['full_name', 'picture']); // eslint-disable-line @typescript-eslint/naming-convention
    const googleTokenExpires = new Date().getTime() + ((tokensObj.expires_in as number) - 120) * 1000; // let our copy expire 2 minutes beforehand
    const toSave: AcctStoreDict = {
      full_name: full_name || parsedOpenId.name, // eslint-disable-line @typescript-eslint/naming-convention
      picture: picture || parsedOpenId.picture,
    };
    if (typeof tokensObj.refresh_token !== 'undefined') {
      toSave.google_token_refresh = tokensObj.refresh_token;
    }
    await AcctStore.set(acctEmail, toSave);
    await InMemoryStore.set(acctEmail, InMemoryStoreKeys.ID_TOKEN, tokensObj.id_token);
    await InMemoryStore.set(acctEmail, InMemoryStoreKeys.GOOGLE_TOKEN_ACCESS, tokensObj.access_token, googleTokenExpires);
  };

  private static googleAuthGetTokens = async (code: string) => {
    return (await Api.ajax(
      {
        /* eslint-disable @typescript-eslint/naming-convention */
        url: Url.create(GoogleOAuth.OAUTH.url_tokens, {
          grant_type: 'authorization_code',
          code,
          client_id: GoogleOAuth.OAUTH.client_id,
          client_secret: GoogleOAuth.OAUTH.client_secret,
          redirect_uri: GoogleOAuth.OAUTH.redirect_uri,
        }),
        /* eslint-enable @typescript-eslint/naming-convention */
        method: 'POST',
        stack: Catch.stackTrace(),
      },
      'json'
    )) as GoogleAuthTokensResponse;
  };

  private static googleAuthRefreshToken = async (refreshToken: string) => {
    const url =
      /* eslint-disable @typescript-eslint/naming-convention */
      Url.create(GoogleOAuth.OAUTH.url_tokens, {
        grant_type: 'refresh_token',
        refreshToken,
        client_id: GoogleOAuth.OAUTH.client_id,
        client_secret: GoogleOAuth.OAUTH.client_secret,
      });
    /* eslint-enable @typescript-eslint/naming-convention */
    const req: Ajax = {
      url,
      method: 'POST',
      stack: Catch.stackTrace(),
    };

    return (await Api.ajax(req, 'json')) as GoogleAuthTokensResponse;
  };

  // eslint-disable-next-line @typescript-eslint/naming-convention
  private static retrieveAndSaveAuthToken = async (authCode: string): Promise<{ id_token: string }> => {
    const tokensObj = await GoogleOAuth.googleAuthGetTokens(authCode);
    const claims = GoogleOAuth.parseIdToken(tokensObj.id_token);
    if (!claims.email) {
      throw new Error('Missing email address in id_token');
    }
    await GoogleOAuth.googleAuthSaveTokens(claims.email, tokensObj);
    return { id_token: tokensObj.id_token }; // eslint-disable-line @typescript-eslint/naming-convention
  };

  private static apiGoogleAuthPopupPrepareAuthReqScopes = async (addScopes: string[]): Promise<string[]> => {
    if (!addScopes.includes(GoogleOAuth.OAUTH.scopes.email)) {
      addScopes.push(GoogleOAuth.OAUTH.scopes.email);
    }
    if (!addScopes.includes(GoogleOAuth.OAUTH.scopes.openid)) {
      addScopes.push(GoogleOAuth.OAUTH.scopes.openid);
    }
    if (!addScopes.includes(GoogleOAuth.OAUTH.scopes.profile)) {
      addScopes.push(GoogleOAuth.OAUTH.scopes.profile);
    }
    return addScopes;
  };
}
