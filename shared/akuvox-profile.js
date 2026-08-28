/**
 * Wbudowany profil chmury Akuvox (akubela OpenAPI).
 *
 * Źródło: https://developer.akubela.com — dokumentacja jest publiczna (V4.1),
 * wejście wskazuje baza wiedzy Akuvox: https://knowledge.akuvox.com/docs/openapi.
 * Poświadczenia (client_id / client_secret) nie są publiczne — trzeba je uzyskać
 * od pomocy technicznej akubela (support@akubela.com), a dokumentacja wymaga,
 * by rozwój i testy prowadzić najpierw na serwerze testowym (.pre.).
 *
 * Dwie cechy tego API, które ukształtowały ten profil:
 *
 * 1. Nie jest to REST. Jest kilka stałych adresów (manager-commands,
 *    user-commands, general-commands), a operację wskazuje pole "command"
 *    w treści JSON: {"command":..., "id":<32 hex>, "param":{...}}.
 *    Odpowiedź ma zawsze kształt {"success":bool,"timestamp":int,"result":...}.
 * 2. Hierarchia obiektów: project → building → residence (zwane też „family”)
 *    → account (mieszkaniec) → rf_card. „Obiekt” z pytania użytkownika to
 *    PROJECT, a „mieszkanie” to RESIDENCE (residence_no to numer widoczny dla
 *    człowieka, np. „101”).
 */

/** Serwery produkcyjne i testowe, wg dokumentacji Overview/Server. */
export const AKUVOX_REGIONS = [
  { id: 'ecloud', name: 'Europa (Frankfurt)', baseUrl: 'https://api.ecloud.akubela.com' },
  { id: 'ucloud', name: 'Ameryka (Kalifornia)', baseUrl: 'https://api.ucloud.akubela.com' },
  { id: 'scloud', name: 'Azja (Singapur)', baseUrl: 'https://api.scloud.akubela.com' },
  { id: 'jcloud', name: 'Japonia (Tokio)', baseUrl: 'https://api.jcloud.akubela.com' },
  { id: 'aucloud', name: 'Australia (Sydney)', baseUrl: 'https://api.aucloud.akubela.com' },
  { id: 'ccloud', name: 'Chiny (Hangzhou)', baseUrl: 'https://api.ccloud.akubela.com' },
  { id: 'ecloud-pre', name: 'Europa — serwer testowy', baseUrl: 'https://api.ecloud.pre.akubela.com' },
  { id: 'ccloud-pre', name: 'Chiny — serwer testowy', baseUrl: 'https://api.ccloud.pre.akubela.com' },
];

const COMMANDS = '/api/v1.0/invoke/open-ability/method/manager-commands';

/**
 * Postać numeru karty wysyłana w polu "number".
 *
 * UWAGA: dokumentacja podaje tylko typ String i przykład "1234567", nie mówi,
 * czy chmura oczekuje wartości dziesiętnej czy HEX. Dlatego jest to ustawienie,
 * a nie stała — po pierwszym udanym przypisaniu warto sprawdzić w panelu
 * SmartPlus, czy numer zgadza się z etykietą karty, i w razie potrzeby zmienić.
 */
export const CARD_FORMATS = [
  { id: 'dec', name: 'dziesiętnie bez zer wiodących (np. 4372425)', hint: 'Zgodne z przykładem z dokumentacji ("1234567").' },
  { id: 'dec10', name: 'dziesiętnie, 10 znaków (np. 0004372425)', hint: 'Tak numer podaje czytnik USB w trybie DEC.' },
  { id: 'hex', name: 'HEX (np. 0042B7C9)', hint: 'Kanoniczny UID, kolejność bajtów jak nadaje karta.' },
  { id: 'hexReversed', name: 'HEX z odwróconymi bajtami (np. C9B74200)', hint: 'Część systemów zapisuje UID odwrotnie.' },
];

/** Profil gotowy do użycia po podaniu adresu, poświadczeń i wybraniu regionu. */
export const AKUVOX_PROFILE = {
  name: 'Akuvox / akubela OpenAPI V4.1',
  docs: 'https://developer.akubela.com',
  baseUrl: 'https://api.ecloud.pre.akubela.com',
  cardFormat: 'dec',

  auth: {
    type: 'login',
    // Token OAuth 2.0 (grant password) — treść w formacie formularza,
    // nie JSON; to jedyne miejsce w tym API z takim kodowaniem.
    headerName: 'Authorization',
    prefix: 'Bearer ',
  },

  operations: {
    /**
     * Sprawdzenie łączności bez tokenu — dobre na przycisk „Sprawdź
     * połączenie”, bo oddziela problem z siecią od problemu z poświadczeniami.
     */
    ping: {
      method: 'GET',
      path: '/api/v1.0/invoke/open-ability/method/versions',
      auth: false,
    },

    login: {
      method: 'POST',
      path: '/api/v1.0/invoke/open-ability/method/oauth2/token',
      bodyType: 'form',
      body: {
        grant_type: 'password',
        client_id: '{clientId}',
        client_secret: '{clientSecret}',
        username: '{username}',
        password: '{password}',
        scope: 'manager',
      },
      tokenPath: 'result.access_token',
      refreshTokenPath: 'result.refresh_token',
      expiresPath: 'result.expires_in',
    },

    refresh: {
      method: 'POST',
      path: '/api/v1.0/invoke/open-ability/method/oauth2/token',
      bodyType: 'form',
      body: {
        grant_type: 'refresh_token',
        client_id: '{clientId}',
        client_secret: '{clientSecret}',
        refresh_token: '{refreshToken}',
      },
      tokenPath: 'result.access_token',
      refreshTokenPath: 'result.refresh_token',
      expiresPath: 'result.expires_in',
    },

    /** Obiekty. W API nazywają się „project”. */
    sites: {
      method: 'POST',
      path: COMMANDS,
      body: {
        command: 'get_project_list',
        id: '{requestId}',
        param: { page_size: '{pageSize}', page_index: '{pageIndex}' },
      },
      listPath: 'result.list',
      idField: 'project_id',
      nameField: 'project_name',
    },

    buildings: {
      method: 'POST',
      path: COMMANDS,
      body: {
        command: 'get_building_list',
        id: '{requestId}',
        param: { project_id: '{siteId}', page_size: '{pageSize}', page_index: '{pageIndex}' },
      },
      listPath: 'result.list',
      idField: 'building_id',
      nameField: 'building_name',
    },

    /** Mieszkania. W API nazywają się „residence”, a ich nazwa to „family”. */
    apartments: {
      method: 'POST',
      path: COMMANDS,
      body: {
        command: 'get_family_list',
        id: '{requestId}',
        param: { project_id: '{siteId}', page_size: '{pageSize}', page_index: '{pageIndex}' },
      },
      listPath: 'result.list',
      idField: 'residence_id',
      nameField: 'family_name',
      extraField: 'residence_no',
    },

    /** Mieszkańcy. W API to „account” w obrębie residence. */
    residents: {
      method: 'POST',
      path: COMMANDS,
      body: {
        command: 'get_user_list',
        id: '{requestId}',
        param: { project_id: '{siteId}', page_size: '{pageSize}', page_index: '{pageIndex}' },
      },
      listPath: 'result.list',
      idField: 'account_id',
      // account_name bywa puste — wtedy sięgamy po imię i nazwisko.
      nameField: ['account_name', 'first_name', 'last_name', 'email'],
      extraField: 'residence_id',
    },

    /** Poświadczenia mieszkańca — pozwala sprawdzić, czy karta już jest. */
    residentAccess: {
      method: 'POST',
      path: COMMANDS,
      body: {
        command: 'get_user_access_info',
        id: '{requestId}',
        param: { project_id: '{siteId}', residence_id: '{apartmentId}', account_id: '{residentId}' },
      },
      listPath: 'result.rf_cards',
      idField: 'rf_card_id',
      nameField: 'number',
    },

    /** Przypisanie karty mieszkańcowi — sedno całej integracji. */
    assignCard: {
      method: 'POST',
      path: COMMANDS,
      body: {
        command: 'create_user_rf_card_access_info',
        id: '{requestId}',
        param: {
          project_id: '{siteId}',
          residence_id: '{apartmentId}',
          account_id: '{residentId}',
          number: '{cardNumber}',
        },
      },
      remoteIdPath: 'result.rf_card_id',
    },

    /**
     * Odebranie karty. Nazwa komendy jest udokumentowana, ale zestaw param
     * wywnioskowano z analogicznej komendy dla kodów PIN — dlatego oznaczone
     * jako niepewne i warto to sprawdzić na serwerze testowym.
     */
    unassignCard: {
      method: 'POST',
      path: COMMANDS,
      body: {
        command: 'delete_user_rf_card_access_info',
        id: '{requestId}',
        param: {
          project_id: '{siteId}',
          residence_id: '{apartmentId}',
          account_id: '{residentId}',
          rf_card_id: '{remoteId}',
        },
      },
    },
  },

  /**
   * Odpowiedź zawsze ma kształt {"success":bool,...}. Bez tego sprawdzenia
   * błąd logiczny z HTTP 200 przeszedłby jako sukces.
   */
  successPath: 'success',
  errorPath: 'message',
};

/** Rzeczy, których dokumentacja nie rozstrzyga — pokazywane w interfejsie. */
export const AKUVOX_CAVEATS = [
  'Format numeru karty: dokumentacja podaje tylko typ tekstowy i przykład „1234567”. Po pierwszym przypisaniu sprawdź w panelu, czy numer zgadza się z etykietą karty.',
  'Nie jest udokumentowane, czy karta zaczyna działać na urządzeniach od razu, czy trzeba jeszcze przypisać mieszkańca do grupy dostępu.',
  'Nie jest jasne, czy projekty prowadzone w starszej chmurze SmartPlus są widoczne przez to API — sprawdź, czy „Obiekty” zwracają Twój projekt.',
  'Zestaw parametrów odebrania karty wywnioskowano z analogicznej komendy dla kodów PIN — przetestuj na serwerze testowym.',
  'Dokumentacja wymaga prowadzenia integracji najpierw na serwerze testowym (.pre.), a poświadczeń trzeba poprosić na support@akubela.com.',
];
