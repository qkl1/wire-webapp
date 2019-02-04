/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import platform from 'platform';
import AssetService from '../assets/AssetService';
import PropertiesRepository from '../properties/PropertiesRepository';
import PropertiesService from '../properties/PropertiesService';
import StorageService from '../storage/StorageService';
import PreferenceNotificationRepository from '../notification/PreferenceNotificationRepository';
import * as UserPermission from '../user/UserPermission';
import UserService from '../user/UserService';
import UserRepository from '../user/UserRepository';

import CacheRepository from '../cache/CacheRepository';
import BackendClient from '../service/BackendClient';
import BackupService from '../backup/BackupService';
import GiphyRepository from '../extension/GiphyRepository';

import AppInitStatisticsValue from '../telemetry/app_init/AppInitStatisticsValue';
import AppInitTimingsStep from '../telemetry/app_init/AppInitTimingsStep';
import AppInitTelemetry from '../telemetry/app_init/AppInitTelemetry';

import DebugUtil from '../util/DebugUtil';

import '../components/mentionSuggestions.js';

import ReceiptsMiddleware from '../event/preprocessor/ReceiptsMiddleware';
import {t} from 'utils/LocalizerUtil';

/* eslint-disable no-unused-vars */
import globals from './globals';
import auth from './auth';
import {getWebsiteUrl} from '../externalRoute';
/* eslint-enable no-unused-vars */

import dependenciesGraph from '../config/dependenciesGraph';
import dependenciesResolver from 'utils/dependenciesResolver';

class App {
  static get CONFIG() {
    return {
      COOKIES_CHECK: {
        COOKIE_NAME: 'cookies_enabled',
      },
      NOTIFICATION_CHECK: z.util.TimeUtil.UNITS_IN_MILLIS.SECOND * 10,
      SIGN_OUT_REASONS: {
        IMMEDIATE: [
          z.auth.SIGN_OUT_REASON.ACCOUNT_DELETED,
          z.auth.SIGN_OUT_REASON.CLIENT_REMOVED,
          z.auth.SIGN_OUT_REASON.SESSION_EXPIRED,
        ],
        TEMPORARY_GUEST: [
          z.auth.SIGN_OUT_REASON.MULTIPLE_TABS,
          z.auth.SIGN_OUT_REASON.SESSION_EXPIRED,
          z.auth.SIGN_OUT_REASON.USER_REQUESTED,
        ],
      },
    };
  }

  /**
   * Construct a new app.
   * @param {z.main.Auth} authComponent - Authentication component
   */
  constructor(authComponent) {
    this.backendClient = authComponent.backendClient;
    this.logger = new z.util.Logger('z.main.App', z.config.LOGGER.OPTIONS);

    this.telemetry = new AppInitTelemetry();
    this.windowHandler = new z.ui.WindowHandler().init();

    this.service = this._setupServices(authComponent);
    this.repository = this._setupRepositories(authComponent);
    this.view = this._setupViewModels();
    this.util = this._setup_utils();

    this._publishGlobals();

    this.instanceId = z.util.createRandomUuid();

    this._onExtraInstanceStarted = this._onExtraInstanceStarted.bind(this);
    this.singleInstanceHandler = new z.main.SingleInstanceHandler(this._onExtraInstanceStarted);

    this._subscribeToEvents();

    this.initApp();
    this.initServiceWorker();
  }

  //##############################################################################
  // Instantiation
  //##############################################################################

  /**
   * Create all app repositories.
   * @param {z.main.Auth} authComponent - Authentication component
   * @returns {Object} All repositories
   */
  _setupRepositories(authComponent) {
    const repositories = {};

    repositories.audio = authComponent.audio;
    repositories.auth = authComponent.repository;
    repositories.giphy = dependenciesResolver.resolve(GiphyRepository);
    repositories.location = new z.location.LocationRepository(this.service.location);
    repositories.permission = new z.permission.PermissionRepository();
    repositories.properties = new PropertiesRepository(this.service.properties, this.service.self);
    repositories.serverTime = new z.time.ServerTimeRepository();
    repositories.storage = new z.storage.StorageRepository(this.service.storage);

    repositories.cryptography = new z.cryptography.CryptographyRepository(
      this.service.cryptography,
      repositories.storage
    );
    repositories.client = new z.client.ClientRepository(this.service.client, repositories.cryptography);
    repositories.media = new z.media.MediaRepository(repositories.permission);
    repositories.user = new UserRepository(
      this.service.user,
      this.service.asset,
      this.service.self,
      repositories.client,
      repositories.serverTime,
      repositories.properties
    );
    repositories.connection = new z.connection.ConnectionRepository(this.service.connection, repositories.user);
    repositories.event = new z.event.EventRepository(
      this.service.event,
      this.service.notification,
      this.service.webSocket,
      this.service.conversation,
      repositories.cryptography,
      repositories.serverTime,
      repositories.user
    );
    repositories.lifecycle = new z.lifecycle.LifecycleRepository(this.service.lifecycle, repositories.user);
    repositories.connect = new z.connect.ConnectRepository(this.service.connect, repositories.properties);
    repositories.links = new z.links.LinkPreviewRepository(this.service.asset, repositories.properties);
    repositories.search = new z.search.SearchRepository(this.service.search, repositories.user);
    repositories.team = new z.team.TeamRepository(this.service.team, repositories.user);
    repositories.eventTracker = new z.tracking.EventTrackingRepository(repositories.team, repositories.user);

    repositories.conversation = new z.conversation.ConversationRepository(
      this.service.conversation,
      this.service.asset,
      repositories.client,
      repositories.connection,
      repositories.cryptography,
      repositories.event,
      repositories.giphy,
      repositories.links,
      repositories.serverTime,
      repositories.team,
      repositories.user,
      repositories.properties
    );

    const serviceMiddleware = new z.event.preprocessor.ServiceMiddleware(repositories.conversation, repositories.user);
    const quotedMessageMiddleware = new z.event.preprocessor.QuotedMessageMiddleware(
      this.service.event,
      z.message.MessageHasher
    );

    const readReceiptMiddleware = new ReceiptsMiddleware(
      this.service.event,
      repositories.user,
      repositories.conversation
    );

    repositories.event.setEventProcessMiddlewares([
      serviceMiddleware.processEvent.bind(serviceMiddleware),
      quotedMessageMiddleware.processEvent.bind(quotedMessageMiddleware),
      readReceiptMiddleware.processEvent.bind(readReceiptMiddleware),
    ]);
    repositories.backup = new z.backup.BackupRepository(
      dependenciesResolver.resolve(BackupService),
      repositories.client,
      repositories.connection,
      repositories.conversation,
      repositories.user
    );
    repositories.broadcast = new z.broadcast.BroadcastRepository(
      this.service.broadcast,
      repositories.client,
      repositories.conversation,
      repositories.cryptography,
      repositories.user
    );
    repositories.calling = new z.calling.CallingRepository(
      this.service.calling,
      repositories.client,
      repositories.conversation,
      repositories.event,
      repositories.media,
      repositories.serverTime,
      repositories.user
    );
    repositories.integration = new z.integration.IntegrationRepository(
      this.service.integration,
      repositories.conversation,
      repositories.team
    );
    repositories.notification = new z.notification.NotificationRepository(
      repositories.calling,
      repositories.conversation,
      repositories.permission,
      repositories.user
    );
    repositories.preferenceNotification = new PreferenceNotificationRepository(repositories.user.self);
    repositories.videoGrid = new z.calling.VideoGridRepository(repositories.calling, repositories.media);

    return repositories;
  }

  /**
   * Create all app services.
   * @param {z.main.Auth} authComponent - Authentication component
   * @returns {Object} All services
   */
  _setupServices(authComponent) {
    const storageService = dependenciesResolver.resolve(StorageService);
    const eventService = z.util.Environment.browser.edge
      ? new z.event.EventServiceNoCompound(storageService)
      : new z.event.EventService(storageService);

    return {
      asset: dependenciesResolver.resolve(AssetService),
      auth: authComponent.service,
      broadcast: new z.broadcast.BroadcastService(this.backendClient),
      calling: new z.calling.CallingService(this.backendClient),
      client: new z.client.ClientService(this.backendClient, storageService),
      connect: new z.connect.ConnectService(this.backendClient),
      // Can be removed once desktop version with the following PR has been published (probably v3.5):
      // https://github.com/wireapp/wire-desktop/pull/1938/files
      connect_google: {},
      connectGoogle: {},
      connection: new z.connection.ConnectionService(this.backendClient),
      conversation: new z.conversation.ConversationService(this.backendClient, eventService, storageService),
      cryptography: new z.cryptography.CryptographyService(this.backendClient),
      event: eventService,
      integration: new z.integration.IntegrationService(this.backendClient),
      lifecycle: new z.lifecycle.LifecycleService(),
      location: new z.location.LocationService(this.backendClient),
      notification: new z.event.NotificationService(this.backendClient, storageService),
      properties: new PropertiesService(this.backendClient),
      search: new z.search.SearchService(this.backendClient),
      self: new z.self.SelfService(this.backendClient),
      storage: storageService,
      team: new z.team.TeamService(this.backendClient),
      user: new UserService(this.backendClient, storageService),
      webSocket: new z.event.WebSocketService(this.backendClient),
    };
  }

  /**
   * Create all app utils.
   * @returns {Object} All utils
   */
  _setup_utils() {
    return z.config.FEATURE.ENABLE_DEBUG ? {debug: new DebugUtil(this.repository)} : {};
  }

  /**
   * Create all app view models.
   * @returns {Object} All view models
   */
  _setupViewModels() {
    return new z.viewModel.MainViewModel(this.repository);
  }

  /**
   * Subscribe to amplify events.
   * @returns {undefined} No return value
   */
  _subscribeToEvents() {
    amplify.subscribe(z.event.WebApp.LIFECYCLE.REFRESH, this.refresh.bind(this));
    amplify.subscribe(z.event.WebApp.LIFECYCLE.SIGN_OUT, this.logout.bind(this));
    amplify.subscribe(z.event.WebApp.LIFECYCLE.UPDATE, this.update.bind(this));
  }

  //##############################################################################
  // Initialization
  //##############################################################################

  /**
   * Initialize the app.
   *
   * @note Locally known clients and sessions must not be touched until after the notification stream has been handled.
   *   Any failure in the Promise chain will result in a logout.
   * @todo Check if we really need to logout the user in all these error cases or how to recover from them
   *
   * @param {boolean} [isReload=_isReload()] - App init after page reload
   * @returns {undefined} No return value
   */
  initApp(isReload = this._isReload()) {
    z.util
      .checkIndexedDb()
      .then(() => this._registerSingleInstance())
      .then(() => this._loadAccessToken())
      .then(() => {
        this.view.loading.updateProgress(2.5);
        this.telemetry.time_step(AppInitTimingsStep.RECEIVED_ACCESS_TOKEN);

        const protoFile = `/proto/messages.proto?${z.util.Environment.version(false)}`;
        return Promise.all([this._initiateSelfUser(), z.util.protobuf.loadProtos(protoFile)]);
      })
      .then(() => {
        this.view.loading.updateProgress(5, t('initReceivedSelfUser'));
        this.telemetry.time_step(AppInitTimingsStep.RECEIVED_SELF_USER);
        return this._initiateSelfUserClients();
      })
      .then(clientEntity => {
        this.view.loading.updateProgress(7.5, t('initValidatedClient'));
        this.telemetry.time_step(AppInitTimingsStep.VALIDATED_CLIENT);
        this.telemetry.add_statistic(AppInitStatisticsValue.CLIENT_TYPE, clientEntity.type);

        return this.repository.cryptography.loadCryptobox(this.service.storage.db);
      })
      .then(() => {
        this.view.loading.updateProgress(10);
        this.telemetry.time_step(AppInitTimingsStep.INITIALIZED_CRYPTOGRAPHY);

        this.repository.event.connectWebSocket();

        const promises = [this.repository.conversation.getConversations(), this.repository.connection.getConnections()];
        return Promise.all(promises);
      })
      .then(([conversationEntities, connectionEntities]) => {
        this.view.loading.updateProgress(25, t('initReceivedUserData'));

        this.telemetry.time_step(AppInitTimingsStep.RECEIVED_USER_DATA);
        this.telemetry.add_statistic(AppInitStatisticsValue.CONVERSATIONS, conversationEntities.length, 50);
        this.telemetry.add_statistic(AppInitStatisticsValue.CONNECTIONS, connectionEntities.length, 50);

        this.repository.conversation.map_connections(this.repository.connection.connectionEntities());
        this._subscribeToUnloadEvents();

        return this.repository.team.getTeam();
      })
      .then(() => this.repository.user.loadUsers())
      .then(() => this.repository.event.initializeFromStream())
      .then(notificationsCount => {
        this.telemetry.time_step(AppInitTimingsStep.UPDATED_FROM_NOTIFICATIONS);
        this.telemetry.add_statistic(AppInitStatisticsValue.NOTIFICATIONS, notificationsCount, 100);

        this.repository.eventTracker.init(this.repository.properties.properties.settings.privacy.improve_wire);
        return this.repository.conversation.initialize_conversations();
      })
      .then(() => {
        this.view.loading.updateProgress(97.5, t('initUpdatedFromNotifications'));

        this._watchOnlineStatus();
        return this.repository.client.updateClientsForSelf();
      })
      .then(clientEntities => {
        this.view.loading.updateProgress(99);

        this.telemetry.add_statistic(AppInitStatisticsValue.CLIENTS, clientEntities.length);
        this.telemetry.time_step(AppInitTimingsStep.APP_PRE_LOADED);

        this.repository.user.self().devices(clientEntities);
        this.logger.info('App pre-loading completed');
        return this._handleUrlParams();
      })
      .then(() => {
        this._showInterface();
        this.telemetry.report();
        amplify.publish(z.event.WebApp.LIFECYCLE.LOADED);
        this.telemetry.time_step(AppInitTimingsStep.APP_LOADED);
        return this.repository.conversation.updateConversationsOnAppInit();
      })
      .then(() => {
        this.telemetry.time_step(AppInitTimingsStep.UPDATED_CONVERSATIONS);
        this.repository.lifecycle.init();
        this.repository.audio.init(true);
        this.repository.conversation.cleanup_conversations();
        this.logger.info('App fully loaded');
      })
      .catch(error => this._appInitFailure(error, isReload));
  }

  /**
   * Initialize ServiceWorker if supported.
   * @returns {undefined} No return value
   */
  initServiceWorker() {
    if (navigator.serviceWorker) {
      navigator.serviceWorker
        .register(`/sw.js?${z.util.Environment.version(false)}`)
        .then(({scope}) => this.logger.info(`ServiceWorker registration successful with scope: ${scope}`));
    }
  }

  /**
   * Behavior when internet connection is re-established.
   * @returns {undefined} No return value
   */
  onInternetConnectionGained() {
    this.logger.info('Internet connection regained. Re-establishing WebSocket connection...');
    this.backendClient.executeOnConnectivity(BackendClient.CONNECTIVITY_CHECK_TRIGGER.CONNECTION_REGAINED).then(() => {
      amplify.publish(z.event.WebApp.WARNING.DISMISS, z.viewModel.WarningsViewModel.TYPE.NO_INTERNET);
      amplify.publish(z.event.WebApp.WARNING.SHOW, z.viewModel.WarningsViewModel.TYPE.CONNECTIVITY_RECONNECT);
      this.repository.event.reconnectWebSocket(z.event.WebSocketService.CHANGE_TRIGGER.ONLINE);
    });
  }

  /**
   * Reflect internet connection loss in the UI.
   * @returns {undefined} No return value
   */
  onInternetConnectionLost() {
    this.logger.warn('Internet connection lost');
    this.repository.event.disconnectWebSocket(z.event.WebSocketService.CHANGE_TRIGGER.OFFLINE);
    amplify.publish(z.event.WebApp.WARNING.SHOW, z.viewModel.WarningsViewModel.TYPE.NO_INTERNET);
  }

  _appInitFailure(error, isReload) {
    let logMessage = `Could not initialize app version '${z.util.Environment.version(false)}'`;
    if (z.util.Environment.desktop) {
      logMessage += ` - Electron '${platform.os.family}' '${z.util.Environment.version()}'`;
    }
    this.logger.warn(`${logMessage}: ${error.message}`, {error});

    const {message, type} = error;
    const isAuthError = error instanceof z.error.AuthError;
    if (isAuthError) {
      const isTypeMultipleTabs = type === z.error.AuthError.TYPE.MULTIPLE_TABS;
      const signOutReason = isTypeMultipleTabs
        ? z.auth.SIGN_OUT_REASON.MULTIPLE_TABS
        : z.auth.SIGN_OUT_REASON.INDEXED_DB;
      return this._redirectToLogin(signOutReason);
    }

    this.logger.debug(
      `App reload: '${isReload}', Document referrer: '${document.referrer}', Location: '${window.location.href}'`
    );
    if (isReload) {
      const isSessionExpired = [
        z.error.AccessTokenError.TYPE.REQUEST_FORBIDDEN,
        z.error.AccessTokenError.TYPE.NOT_FOUND_IN_CACHE,
      ];

      if (isSessionExpired.includes(type)) {
        this.logger.error(`Session expired on page reload: ${message}`, error);
        Raygun.send(new Error('Session expired on page reload', error));
        return this._redirectToLogin(z.auth.SIGN_OUT_REASON.SESSION_EXPIRED);
      }

      const isAccessTokenError = error instanceof z.error.AccessTokenError;
      const isInvalidClient = type === z.error.ClientError.TYPE.NO_VALID_CLIENT;

      if (isAccessTokenError || isInvalidClient) {
        this.logger.warn('Connectivity issues. Trigger reload on regained connectivity.', error);
        const triggerSource = isAccessTokenError
          ? BackendClient.CONNECTIVITY_CHECK_TRIGGER.ACCESS_TOKEN_RETRIEVAL
          : BackendClient.CONNECTIVITY_CHECK_TRIGGER.APP_INIT_RELOAD;
        return this.backendClient.executeOnConnectivity(triggerSource).then(() => window.location.reload(false));
      }
    }

    if (navigator.onLine) {
      switch (type) {
        case z.error.AccessTokenError.TYPE.NOT_FOUND_IN_CACHE:
        case z.error.AccessTokenError.TYPE.RETRIES_EXCEEDED:
        case z.error.AccessTokenError.TYPE.REQUEST_FORBIDDEN: {
          this.logger.warn(`Redirecting to login: ${error.message}`, error);
          return this._redirectToLogin(z.auth.SIGN_OUT_REASON.NOT_SIGNED_IN);
        }

        default: {
          this.logger.error(`Caused by: ${(error ? error.message : undefined) || error}`, error);

          const isAccessTokenError = error instanceof z.error.AccessTokenError;
          if (isAccessTokenError) {
            this.logger.error(`Could not get access token: ${error.message}. Logging out user.`, error);
          } else {
            Raygun.send(error);
          }

          return this.logout(z.auth.SIGN_OUT_REASON.APP_INIT);
        }
      }
    }

    this.logger.warn('No connectivity. Trigger reload on regained connectivity.', error);
    this._watchOnlineStatus();
  }

  /**
   * Check whether we need to set different user information (picture, username).
   * @param {z.entity.User} userEntity - Self user entity
   * @returns {z.entity.User} Checked user entity
   */
  _checkUserInformation(userEntity) {
    if (userEntity.hasActivatedIdentity()) {
      if (!userEntity.mediumPictureResource()) {
        this.repository.user.set_default_picture();
      }
      if (!userEntity.username()) {
        this.repository.user.get_username_suggestion();
      }
    }

    return userEntity;
  }

  /**
   * Initiate the self user by getting it from the backend.
   * @returns {Promise<z.entity.User>} Resolves with the self user entity
   */
  _initiateSelfUser() {
    return this.repository.user.getSelf().then(userEntity => {
      this.logger.info(`Loaded self user with ID '${userEntity.id}'`);

      if (!userEntity.hasActivatedIdentity()) {
        this.logger.info('User does not have an activated identity and seems to be a temporary guest');

        if (!userEntity.isTemporaryGuest()) {
          throw new Error('User does not have an activated identity');
        }
      }

      return this.service.storage
        .init(userEntity.id)
        .then(() => this.repository.client.init(userEntity))
        .then(() => this.repository.properties.init(userEntity))
        .then(() => this._checkUserInformation(userEntity));
    });
  }

  /**
   * Initiate the current client of the self user.
   * @returns {Promise<z.client.Client>} Resolves with the local client entity
   */
  _initiateSelfUserClients() {
    return this.repository.client
      .getValidLocalClient()
      .then(clientObservable => {
        this.repository.cryptography.currentClient = clientObservable;
        this.repository.event.currentClient = clientObservable;
        return this.repository.client.getClientsForSelf();
      })
      .then(() => this.repository.client.currentClient());
  }

  /**
   * Handle URL params.
   * @private
   * @returns {undefined} Not return value
   */
  _handleUrlParams() {
    // Currently no URL params to be handled
  }

  /**
   * Check whether the page has been reloaded.
   * @private
   * @returns {boolean}  True if it is a page refresh
   */
  _isReload() {
    const isReload = z.util.isSameLocation(document.referrer, window.location.href);
    const log = `App reload: '${isReload}', Referrer: '${document.referrer}', Location: '${window.location.href}'`;
    this.logger.debug(log);
    return isReload;
  }

  /**
   * Load the access token from cache or get one from the backend.
   * @returns {Promise} Resolves with the access token
   */
  _loadAccessToken() {
    const isLocalhost = z.util.Environment.frontend.isLocalhost();
    const referrer = document.referrer.toLowerCase();
    const isLoginRedirect = referrer.includes('/auth') || referrer.includes('/login');
    const getCachedToken = isLocalhost || isLoginRedirect;

    return getCachedToken ? this.repository.auth.getCachedAccessToken() : this.repository.auth.getAccessToken();
  }

  //##############################################################################
  // Multiple tabs check
  //##############################################################################

  /**
   * Check that this is the single instance tab of the app.
   * @returns {Promise} Resolves when page is the first tab
   */
  _registerSingleInstance() {
    if (this.singleInstanceHandler.registerInstance(this.instanceId)) {
      this._registerSingleInstanceCleaning();
      return Promise.resolve();
    }
    return Promise.reject(new z.error.AuthError(z.error.AuthError.TYPE.MULTIPLE_TABS));
  }

  _registerSingleInstanceCleaning(singleInstanceCheckIntervalId) {
    $(window).on('beforeunload', () => {
      this.singleInstanceHandler.deregisterInstance();
    });
  }

  /**
   * Hide the loading spinner and show the application UI.
   * @returns {undefined} No return value
   */
  _showInterface() {
    const conversationEntity = this.repository.conversation.getMostRecentConversation();
    this.logger.info('Showing application UI');
    if (this.repository.user.isTemporaryGuest()) {
      this.view.list.showTemporaryGuest();
    } else if (this.repository.user.shouldChangeUsername()) {
      this.view.list.showTakeover();
    } else if (conversationEntity) {
      amplify.publish(z.event.WebApp.CONVERSATION.SHOW, conversationEntity);
    } else if (this.repository.user.connect_requests().length) {
      amplify.publish(z.event.WebApp.CONTENT.SWITCH, z.viewModel.ContentViewModel.STATE.CONNECTION_REQUESTS);
    }

    this.view.loading.removeFromView();
    $('#wire-main').attr('data-uie-value', 'is-loaded');

    this.repository.properties.checkPrivacyPermission().then(() => {
      window.setTimeout(() => this.repository.notification.checkPermission(), App.CONFIG.NOTIFICATION_CHECK);
    });
  }

  /**
   * Subscribe to 'beforeunload' to stop calls and disconnect the WebSocket.
   * @returns {undefined} No return value
   */
  _subscribeToUnloadEvents() {
    $(window).on('unload', () => {
      this.logger.info("'window.onunload' was triggered, so we will disconnect from the backend.");
      this.repository.event.disconnectWebSocket(z.event.WebSocketService.CHANGE_TRIGGER.PAGE_NAVIGATION);
      this.repository.calling.leaveCallOnUnload();

      if (this.repository.user.isActivatedAccount()) {
        this.repository.storage.terminate('window.onunload');
      } else {
        this.repository.conversation.leaveGuestRoom();
        this.repository.storage.deleteDatabase();
      }

      this.repository.notification.clearNotifications();
    });
  }

  /**
   * Subscribe to 'navigator.onLine' related events.
   * @returns {undefined} No return value
   */
  _watchOnlineStatus() {
    this.logger.info('Watching internet connectivity status');
    $(window).on('offline', this.onInternetConnectionLost.bind(this));
    $(window).on('online', this.onInternetConnectionGained.bind(this));
  }

  //##############################################################################
  // Lifecycle
  //##############################################################################

  /**
   * Logs the user out on the backend and deletes cached data.
   *
   * @param {z.auth.SIGN_OUT_REASON} signOutReason - Cause for logout
   * @param {boolean} clearData - Keep data in database
   * @returns {undefined} No return value
   */
  logout(signOutReason, clearData = false) {
    const _redirectToLogin = () => {
      amplify.publish(z.event.WebApp.LIFECYCLE.SIGNED_OUT, clearData);
      this._redirectToLogin(signOutReason);
    };

    const _logout = () => {
      // Disconnect from our backend, end tracking and clear cached data
      this.repository.event.disconnectWebSocket(z.event.WebSocketService.CHANGE_TRIGGER.LOGOUT);

      // Clear Local Storage (but don't delete the cookie label if you were logged in with a permanent client)
      const keysToKeep = [z.storage.StorageKey.AUTH.SHOW_LOGIN];

      const keepPermanentDatabase = this.repository.client.isCurrentClientPermanent() && !clearData;
      if (keepPermanentDatabase) {
        keysToKeep.push(z.storage.StorageKey.AUTH.PERSIST);
      }

      // @todo remove on next iteration
      const selfUser = this.repository.user.self();
      if (selfUser) {
        const cookieLabelKey = this.repository.client.constructCookieLabelKey(selfUser.email() || selfUser.phone());

        Object.keys(amplify.store()).forEach(keyInAmplifyStore => {
          const isCookieLabelKey = keyInAmplifyStore === cookieLabelKey;
          const deleteLabelKey = isCookieLabelKey && clearData;
          const isCookieLabel = z.util.StringUtil.includes(keyInAmplifyStore, z.storage.StorageKey.AUTH.COOKIE_LABEL);

          if (!deleteLabelKey && isCookieLabel) {
            keysToKeep.push(keyInAmplifyStore);
          }
        });

        const keepConversationInput = signOutReason === z.auth.SIGN_OUT_REASON.SESSION_EXPIRED;
        dependenciesResolver.resolve(CacheRepository).clearCache(keepConversationInput, keysToKeep);
      }

      // Clear IndexedDB
      const clearDataPromise = clearData
        ? this.repository.storage
            .deleteDatabase()
            .catch(error => this.logger.error('Failed to delete database before logout', error))
        : Promise.resolve();

      return clearDataPromise.then(() => _redirectToLogin());
    };

    const _logoutOnBackend = () => {
      this.logger.info(`Logout triggered by '${signOutReason}': Disconnecting user from the backend.`);
      return this.repository.auth
        .logout()
        .then(() => _logout())
        .catch(() => _redirectToLogin());
    };

    if (App.CONFIG.SIGN_OUT_REASONS.IMMEDIATE.includes(signOutReason)) {
      return _logout();
    }

    if (navigator.onLine) {
      return _logoutOnBackend();
    }

    this.logger.warn('No internet access. Continuing when internet connectivity regained.');
    $(window).on('online', () => _logoutOnBackend());
  }

  /**
   * Refresh the web app or desktop wrapper
   * @returns {undefined} No return value
   */
  refresh() {
    this.logger.info(`Refresh to update started`);
    if (z.util.Environment.desktop) {
      // if we are in a desktop env, we just warn the wrapper that we need to reload. It then decide what should be done
      return amplify.publish(z.event.WebApp.LIFECYCLE.RESTART, z.lifecycle.UPDATE_SOURCE.WEBAPP);
    }

    window.location.reload(true);
    window.focus();
  }

  /**
   * Notify about found update
   * @returns {undefined} No return value
   */
  update() {
    amplify.publish(z.event.WebApp.WARNING.SHOW, z.viewModel.WarningsViewModel.TYPE.LIFECYCLE_UPDATE);
  }

  /**
   * Redirect to the login page after internet connectivity has been verified.
   * @param {z.auth.SIGN_OUT_REASON} signOutReason - Redirect triggered by session expiration
   * @returns {undefined} No return value
   */
  _redirectToLogin(signOutReason) {
    this.logger.info(`Redirecting to login after connectivity verification. Reason: ${signOutReason}`);
    this.backendClient.executeOnConnectivity(BackendClient.CONNECTIVITY_CHECK_TRIGGER.LOGIN_REDIRECT).then(() => {
      const isTemporaryGuestReason = App.CONFIG.SIGN_OUT_REASONS.TEMPORARY_GUEST.includes(signOutReason);
      const isLeavingGuestRoom = isTemporaryGuestReason && this.repository.user.isTemporaryGuest();
      if (isLeavingGuestRoom) {
        const path = t('urlWebsiteRoot');
        const url = getWebsiteUrl(path);
        return window.location.replace(url);
      }

      let url = `/auth/${location.search}`;
      const isImmediateSignOutReason = App.CONFIG.SIGN_OUT_REASONS.IMMEDIATE.includes(signOutReason);
      if (isImmediateSignOutReason) {
        url = z.util.URLUtil.appendParameter(url, `${z.auth.URLParameter.REASON}=${signOutReason}`);
      }

      const redirectToLogin = signOutReason !== z.auth.SIGN_OUT_REASON.NOT_SIGNED_IN;
      if (redirectToLogin) {
        url = `${url}#login`;
      }

      window.location.replace(url);
    });
  }

  //##############################################################################
  // Debugging
  //##############################################################################

  /**
   * Disable debugging on any environment.
   * @returns {undefined} No return value
   */
  disableDebugging() {
    z.config.LOGGER.OPTIONS.domains['app.wire.com'] = () => 0;
    this.repository.properties.savePreference(z.properties.PROPERTIES_TYPE.ENABLE_DEBUGGING, false);
  }

  /**
   * Enable debugging on any environment.
   * @returns {undefined} No return value
   */
  enableDebugging() {
    z.config.LOGGER.OPTIONS.domains['app.wire.com'] = () => 300;
    this.repository.properties.savePreference(z.properties.PROPERTIES_TYPE.ENABLE_DEBUGGING, true);
  }

  /**
   * Report call telemetry to Raygun for analysis.
   * @returns {undefined} No return value
   */
  reportCall() {
    this.repository.calling.reportCall();
  }

  _onExtraInstanceStarted() {
    return this._redirectToLogin(z.auth.SIGN_OUT_REASON.MULTIPLE_TABS);
  }

  _publishGlobals() {
    window.z.userPermission = ko.observable({});
    ko.pureComputed(() => {
      const selfUser = this.repository.user.self();
      return selfUser && selfUser.teamRole();
    }).subscribe(role => window.z.userPermission(UserPermission.generatePermissionHelpers(role)));
  }
}

//##############################################################################
// Setting up the App
//##############################################################################

$(() => {
  if ($('#wire-main-app').length !== 0) {
    dependenciesResolver.init(dependenciesGraph, z.config.LOGGER.OPTIONS);
    wire.app = new App(wire.auth);
  }
});

export default App;
