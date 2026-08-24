import { apiRequest, type ClientConfig } from "../http.ts";

export function statusPagesList(client: ClientConfig): Promise<unknown> {
  return apiRequest(client, { path: "/status-pages" });
}
