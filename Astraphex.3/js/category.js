import { mountCatalog } from "./catalog.js";

/** Category page: the shared catalog with ?cat= / ?q= kept in the URL. Buy buttons link to the product page. */
mountCatalog({ urlSync: true });
