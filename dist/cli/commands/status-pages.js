import { apiRequest } from "../http.js";
export function statusPagesList(client) {
    return apiRequest(client, { path: "/status-pages" });
}
