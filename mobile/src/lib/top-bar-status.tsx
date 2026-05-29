import {
  createContext,
  useContext,
  type Dispatch,
  type SetStateAction,
} from "react";

type TopBarStatusContextValue = {
  setSyncing: Dispatch<SetStateAction<boolean>>;
};

const TopBarStatusContext = createContext<TopBarStatusContextValue>({
  setSyncing: () => {},
});

export const TopBarStatusProvider = TopBarStatusContext.Provider;

export function useTopBarStatus() {
  return useContext(TopBarStatusContext);
}
