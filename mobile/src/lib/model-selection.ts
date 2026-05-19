import { useCallback, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getJson } from "./http";

export const STELLA_DEFAULT_MODEL = "stella/default";
const SELECTED_MODEL_KEY = "stella-mobile.selected-stella-model";

export type StellaMobileModel = {
  id: string;
  name: string;
  allowedForAudience: boolean;
};

type ModelsResponse = {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    provider?: unknown;
    allowedForAudience?: unknown;
  }>;
};

const FALLBACK_MODELS: StellaMobileModel[] = [
  {
    id: STELLA_DEFAULT_MODEL,
    name: "Stella Recommended",
    allowedForAudience: true,
  },
  {
    id: "stella/light",
    name: "Stella Light",
    allowedForAudience: true,
  },
  {
    id: "stella/standard",
    name: "Stella Standard",
    allowedForAudience: false,
  },
  {
    id: "stella/priority",
    name: "Stella Priority",
    allowedForAudience: false,
  },
];

const MOBILE_MODEL_IDS = new Set([
  STELLA_DEFAULT_MODEL,
  "stella/light",
  "stella/standard",
  "stella/priority",
  "stella/builder",
  "stella/designer",
  "stella/vision",
]);

let cachedSelection = STELLA_DEFAULT_MODEL;

const normalizeSelection = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === STELLA_DEFAULT_MODEL) return STELLA_DEFAULT_MODEL;
  return trimmed.startsWith("stella/") ? trimmed : STELLA_DEFAULT_MODEL;
};

export async function loadSelectedStellaModel() {
  cachedSelection = normalizeSelection(
    await AsyncStorage.getItem(SELECTED_MODEL_KEY),
  );
  return cachedSelection;
}

export async function saveSelectedStellaModel(modelId: string) {
  const next = normalizeSelection(modelId);
  cachedSelection = next;
  if (next === STELLA_DEFAULT_MODEL) {
    await AsyncStorage.removeItem(SELECTED_MODEL_KEY);
  } else {
    await AsyncStorage.setItem(SELECTED_MODEL_KEY, next);
  }
  return next;
}

export async function fetchStellaModels(): Promise<StellaMobileModel[]> {
  let parsed: ModelsResponse;
  try {
    parsed = (await getJson("/api/stella/models")) as ModelsResponse;
  } catch {
    return FALLBACK_MODELS;
  }
  const models =
    parsed.data
      ?.filter((model) => model.provider === "stella")
      .map((model) => ({
        id: typeof model.id === "string" ? model.id : "",
        name: typeof model.name === "string" ? model.name : "",
        allowedForAudience: model.allowedForAudience !== false,
      }))
      .filter((model) => MOBILE_MODEL_IDS.has(model.id) && model.name) ?? [];
  return models.length > 0 ? models : FALLBACK_MODELS;
}

export function useStellaModelSelection() {
  const [models, setModels] = useState<StellaMobileModel[]>(FALLBACK_MODELS);
  const [selectedModel, setSelectedModel] = useState(cachedSelection);

  useEffect(() => {
    let cancelled = false;
    void loadSelectedStellaModel().then((value) => {
      if (!cancelled) setSelectedModel(value);
    });
    void fetchStellaModels().then((next) => {
      if (!cancelled) setModels(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectModel = useCallback(async (modelId: string) => {
    const next = await saveSelectedStellaModel(modelId);
    setSelectedModel(next);
  }, []);

  const selectedModelLabel = useMemo(() => {
    return (
      models.find((model) => model.id === selectedModel)?.name ??
      FALLBACK_MODELS.find((model) => model.id === selectedModel)?.name ??
      "Stella"
    );
  }, [models, selectedModel]);

  return {
    models,
    selectedModel,
    selectedModelLabel,
    selectModel,
  };
}
