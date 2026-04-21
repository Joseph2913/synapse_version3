import { Composition, Folder } from "remotion";
import { z } from "zod";
import {
  LinkedInUpdate,
  LinkedInUpdateSchema,
} from "./compositions/LinkedInUpdate";
import {
  InstagramStory,
  InstagramStorySchema,
} from "./compositions/InstagramStory";
import {
  InstagramPost,
  InstagramPostSchema,
} from "./compositions/InstagramPost";
import {
  KnowledgeCompounds,
  KnowledgeCompoundsSchema,
} from "./compositions/KnowledgeCompounds";
import { TranscriptExtraction } from "./compositions/week1/TranscriptExtraction";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="LinkedIn">
        <Composition
          id="TranscriptExtraction"
          component={TranscriptExtraction}
          durationInFrames={300}
          fps={30}
          width={1080}
          height={1350}
        />
        <Composition
          id="KnowledgeCompounds"
          component={KnowledgeCompounds}
          durationInFrames={900}
          fps={30}
          width={1920}
          height={1080}
          schema={KnowledgeCompoundsSchema}
          defaultProps={{}}
        />
        <Composition
          id="LinkedInUpdate"
          component={LinkedInUpdate}
          durationInFrames={300}
          fps={30}
          width={1920}
          height={1080}
          schema={LinkedInUpdateSchema}
          defaultProps={{
            title: "Synapse Update",
            subtitle: "Your personal knowledge graph",
            accentColor: "#d63a00",
          }}
        />
      </Folder>
      <Folder name="Instagram">
        <Composition
          id="InstagramPost"
          component={InstagramPost}
          durationInFrames={300}
          fps={30}
          width={1080}
          height={1080}
          schema={InstagramPostSchema}
          defaultProps={{
            title: "Synapse Update",
            subtitle: "Your personal knowledge graph",
            accentColor: "#d63a00",
          }}
        />
        <Composition
          id="InstagramStory"
          component={InstagramStory}
          durationInFrames={450}
          fps={30}
          width={1080}
          height={1920}
          schema={InstagramStorySchema}
          defaultProps={{
            title: "Synapse Update",
            subtitle: "Your personal knowledge graph",
            accentColor: "#d63a00",
          }}
        />
      </Folder>
    </>
  );
};
